//! Tailscale 페어링 QR 이 실을 이 PC 의 tailnet 주소 판정 (ADR-0016 amendment 2026-11-25).
//!
//! 주소 자체는 글루가 `lan_ip()` 와 같은 UDP `connect` 기법으로 얻는다: 목적지를
//! [`DNS_PROBE`] 로 두면 라우팅 테이블이 고른 출발 주소가 나온다. Tailscale 이 연결돼
//! 있으면 그 경로가 Tailscale 인터페이스로 가고, 끊겨 있으면 기본 경로(LAN)로 간다 —
//! 그래서 나온 주소가 tailnet 대역인지가 "연결됨"의 판정이다.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// Tailscale 의 MagicDNS 주소(quad-100). 클라이언트는 IPv4 주소를 받으면 이 /32 경로를
/// 자기 인터페이스에 건다. `connect` 는 패킷을 보내지 않으므로 실제로 질의하지 않는다.
pub const DNS_PROBE: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(100, 100, 100, 100)), 53);

/// Tailscale 이 노드에 주는 IPv4 대역 100.64.0.0/10(RFC 6598 공유 주소 공간) 안이면
/// 그 주소를 돌려준다. 같은 대역을 쓰는 통신사 CGNAT 망에 PC 가 직접 붙은 경우는
/// 구분하지 못한다 — 그때 QR 은 LAN 주소를 싣는다.
pub fn tailnet_ipv4(local: IpAddr) -> Option<Ipv4Addr> {
    match local {
        IpAddr::V4(ip) => {
            let [first, second, ..] = ip.octets();
            (first == 100 && second & 0b1100_0000 == 64).then_some(ip)
        }
        IpAddr::V6(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    #[test]
    fn accepts_the_whole_shared_address_range() {
        for ip in [
            v4(100, 64, 0, 1),
            v4(100, 101, 2, 3),
            v4(100, 127, 255, 254),
        ] {
            assert_eq!(tailnet_ipv4(ip).map(IpAddr::V4), Some(ip));
        }
    }

    #[test]
    fn rejects_neighbours_of_the_range_and_lan_addresses() {
        for ip in [
            v4(100, 63, 255, 255),
            v4(100, 128, 0, 0),
            v4(192, 168, 0, 12),
            v4(172, 30, 1, 13),
            v4(127, 0, 0, 1),
        ] {
            assert_eq!(tailnet_ipv4(ip), None, "{ip}");
        }
    }

    #[test]
    fn rejects_ipv6() {
        let tailnet_v6: IpAddr = "fd7a:115c:a1e0::1".parse().unwrap();
        assert_eq!(tailnet_ipv4(tailnet_v6), None);
    }
}
