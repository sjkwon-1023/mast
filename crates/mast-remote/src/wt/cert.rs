//! Secure Remote 의 TLS 인증서 — 메모리에서만 사는 ECDSA P-256 자체 서명 X.509v3.
//!
//! 브라우저의 WebTransport `serverCertificateHashes` 는 공인 CA 신뢰를 대신하는
//! **개별 연결용** 검증이다. 그 요구(W3C WebTransport §3.3)를 그대로 따른다:
//! ECDSA P-256 키, 자체 서명, 유효기간 2주 이내, DER 바이트의 SHA-256 을 클라이언트가
//! 들고 연결한다. 그래서 이 파일은 인증서를 디스크에 쓰지 않는다 — 발급은
//! [`Certificate::generate`], 폐기는 값이 drop 되는 순간이다.

use std::net::{IpAddr, Ipv4Addr};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use web_transport_quinn::quinn::rustls::pki_types::{
    CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer,
};

/// notBefore 를 지금보다 앞당기는 폭 — 폰의 시계가 조금 느려도 "아직 유효하지 않음"
/// 으로 거절당하지 않게 한다.
const BACKDATE: time::Duration = time::Duration::hours(24);
/// notAfter 까지의 잔여 유효기간. 전체 유효기간(BACKDATE + VALIDITY = 13일)이 2주
/// 상한 안에 들어오면서, 시계 오차를 감안해도 12일은 남는다.
const VALIDITY: time::Duration = time::Duration::days(12);

/// 서버가 소유하는 인증서·개인키·해시. `chain`/`key` 는 TLS 설정으로 넘어가고,
/// 이 값이 drop 되면 개인키도 함께 사라진다 (Secure Remote 종료 = 폐기).
pub(crate) struct Certificate {
    pub(crate) chain: Vec<CertificateDer<'static>>,
    pub(crate) key: PrivateKeyDer<'static>,
    /// DER 바이트 그대로의 SHA-256 — QR 과 WebTransport 옵션에 실리는 값이다.
    pub(crate) hash: [u8; 32],
    not_before: time::OffsetDateTime,
    not_after: time::OffsetDateTime,
}

impl Certificate {
    /// `ip` 를 SAN 으로 갖는 자체 서명 인증서를 새로 발급한다.
    pub(crate) fn generate(ip: Ipv4Addr) -> Result<Self, rcgen::Error> {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
        let now = time::OffsetDateTime::now_utc();
        let mut params = rcgen::CertificateParams::default();
        params.distinguished_name = rcgen::DistinguishedName::new();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "mast secure remote");
        params.not_before = now - BACKDATE;
        params.not_after = params.not_before + BACKDATE + VALIDITY;
        params.subject_alt_names = vec![rcgen::SanType::IpAddress(IpAddr::V4(ip))];
        params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];

        let cert = params.self_signed(&key)?;
        let der = cert.der().clone();
        let hash: [u8; 32] = Sha256::digest(der.as_ref()).into();
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
        Ok(Self {
            chain: vec![der],
            key,
            hash,
            not_before: params.not_before,
            not_after: params.not_after,
        })
    }

    /// `now` 가 유효 구간 안인가. 발급 직후에는 항상 참이어야 하고, 발급 파라미터가
    /// 시계·오차 계산과 어긋나면 여기서 loud 하게 걸린다.
    pub(crate) fn is_valid_at(&self, now: time::OffsetDateTime) -> bool {
        self.not_before <= now && now <= self.not_after
    }

    /// QR·클라이언트 옵션에 넣는 `base64url(SHA-256(DER))` — 패딩 없는 43자다.
    pub(crate) fn hash_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cert() -> Certificate {
        Certificate::generate(Ipv4Addr::new(192, 168, 0, 20)).unwrap()
    }

    #[test]
    fn the_hash_is_sha256_of_the_der_bytes() {
        let cert = cert();
        let expected: [u8; 32] = Sha256::digest(cert.chain[0].as_ref()).into();
        assert_eq!(cert.hash, expected);
        assert_eq!(cert.hash_base64().len(), 43);
        assert!(!cert.hash_base64().contains('='));
    }

    #[test]
    fn the_validity_window_stays_under_two_weeks_and_covers_now() {
        let cert = cert();
        let now = time::OffsetDateTime::now_utc();
        assert!(cert.not_before < now);
        assert!(cert.not_after > now, "발급 직후인데 만료됐다");
        assert!(cert.is_valid_at(now));

        let span = cert.not_after - cert.not_before;
        assert!(
            span <= time::Duration::days(14),
            "WebTransport 해시 인증서의 유효기간 상한은 2주다: {span}"
        );
        let remaining = cert.not_after - now;
        assert!(
            remaining >= time::Duration::days(11),
            "시계 오차를 감안해도 11일 이상 남아야 한다: {remaining}"
        );
    }

    #[test]
    fn the_certificate_uses_ecdsa_p256_and_carries_the_ip_san() {
        let cert = cert();
        let der = cert.chain[0].as_ref();
        // id-ecPublicKey + prime256v1: OID 1.2.840.10045.2.1 / 1.2.840.10045.3.1.7.
        const P256_SPKI: &[u8] = &[
            0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
            0xce, 0x3d, 0x03, 0x01, 0x07,
        ];
        assert!(
            der.windows(P256_SPKI.len()).any(|w| w == P256_SPKI),
            "P-256 SPKI OID 가 없다"
        );
        // iPAddress SAN: context tag 0x87, 길이 4, 그리고 주소 바이트.
        let san = [0x87, 0x04, 192, 168, 0, 20];
        assert!(der.windows(san.len()).any(|w| w == san), "SAN(IP) 이 없다");
    }

    #[test]
    fn two_certificates_are_distinct() {
        let a = cert();
        let b = cert();
        assert_ne!(a.hash, b.hash, "발급마다 새 키·인증서여야 한다");
    }
}
