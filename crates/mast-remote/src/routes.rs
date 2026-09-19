//! 경로 → 라우트 판정. I/O 도 상태도 없는 순수 함수라 표를 그대로 테스트할 수 있다.
//!
//! 라우트에 맞지 않는 것은 전부 [`Route::NotFound`] 다 — 메서드가 다른 경우도, `OPTIONS`
//! 도(ADR-0016 결정 4: CORS 는 어떤 응답에도 없다). 405·501 로 나누지 않는 것은 밖에서 표면의
//! 모양을 읽어 내는 재료를 주지 않기 위해서다.

use crate::http::Method;

/// 정적 자산은 번들 안에서 `remote/` 아래에 있다.
const INDEX_KEY: &str = "remote/index.html";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Route {
    State,
    Screen {
        tab: u64,
        since: Option<u64>,
        session: Option<String>,
    },
    Input {
        tab: u64,
        session: Option<String>,
    },
    /// PTY 크기의 소유권 요청 (ADR-0016 개정) — 폰의 Mobile/Desktop 버튼이 낸다.
    Resize {
        tab: u64,
        session: Option<String>,
        mode: ResizeMode,
    },
    /// 자산 콜백에 넘길 키. 이미 세그먼트 규칙을 통과한 값이다.
    Static {
        key: String,
    },
    NotFound,
    /// 라우트는 맞는데 쿼리가 깨졌다 — 400.
    BadRequest,
}

/// `POST /api/tabs/{id}/resize?mode=…` 의 모드. 폰이 `mobile` 로 크기를 주장하면
/// PTY 가 그 크기로 줄고, `desktop` 은 소유권을 데스크톱에 돌려준다 (복원 크기는
/// 서버가 기억한 현재 데스크톱 pane 크기 — 클라이언트는 크기를 보내지 않는다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResizeMode {
    Desktop,
    Mobile { cols: u16, rows: u16 },
}

/// 탭 id 는 여기서 `u64` 로만 나른다. 모델의 `TabId` 로 옮기는 것은 핸들러(B2)의 몫이고,
/// 이 모듈은 mast-core 를 알지 못한다.
pub(crate) fn route(method: Method, path: &str, query: Option<&str>) -> Route {
    let Some(rest) = path.strip_prefix('/') else {
        // origin-form 이 아닌 요청 타깃(absolute-form·authority-form)은 우리 표면이 아니다.
        return Route::NotFound;
    };
    if rest.is_empty() {
        return match method {
            Method::Get => Route::Static {
                key: INDEX_KEY.to_string(),
            },
            _ => Route::NotFound,
        };
    }

    let segments: Vec<&str> = rest.split('/').collect();
    match segments.as_slice() {
        ["api", "state"] if method == Method::Get => Route::State,
        ["api", "tabs", tab, "screen"] if method == Method::Get => {
            let Some(tab) = parse_u64(tab) else {
                return Route::NotFound;
            };
            let since = match query_param(query, "since") {
                None => None,
                Some(raw) => match parse_u64(raw) {
                    Some(value) => Some(value),
                    None => return Route::BadRequest,
                },
            };
            Route::Screen {
                tab,
                since,
                session: session_param(query),
            }
        }
        ["api", "tabs", tab, "input"] if method == Method::Post => {
            let Some(tab) = parse_u64(tab) else {
                return Route::NotFound;
            };
            Route::Input {
                tab,
                session: session_param(query),
            }
        }
        ["api", "tabs", tab, "resize"] if method == Method::Post => {
            let Some(tab) = parse_u64(tab) else {
                return Route::NotFound;
            };
            let mode = match query_param(query, "mode") {
                Some("desktop") => ResizeMode::Desktop,
                Some("mobile") => {
                    let (Some(cols), Some(rows)) = (
                        query_param(query, "cols").and_then(parse_u16),
                        query_param(query, "rows").and_then(parse_u16),
                    ) else {
                        return Route::BadRequest;
                    };
                    ResizeMode::Mobile { cols, rows }
                }
                // 모드 누락·오타는 깨진 쿼리다. 기본값을 지어내면 클라이언트가
                // 어느 쪽을 요청했는지와 서버가 한 일이 갈린다.
                _ => return Route::BadRequest,
            };
            Route::Resize {
                tab,
                session: session_param(query),
                mode,
            }
        }
        ["remote", tail @ ..] if method == Method::Get && !tail.is_empty() => {
            if tail.iter().all(|seg| is_safe_segment(seg)) {
                Route::Static {
                    key: rest.to_string(),
                }
            } else {
                Route::NotFound
            }
        }
        _ => Route::NotFound,
    }
}

/// 정적 경로 세그먼트 규칙 `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
///
/// 퍼센트 디코딩을 하지 않는 것이 경로 순회 방어의 전부다 — 디코딩하지 않으면 `%2e%2e` 는
/// 그냥 `%` 로 시작하는 이름이라 이 규칙에서 걸리고, 디코딩하면 `..` 로 되살아난다. 이
/// 좁은 규칙으로 충분한 이유는 실제로 서빙할 파일이 Vite 산출물(`index.html`,
/// `assets/index-<hash>.js`)뿐이고 그 이름들이 전부 이 안에 들어오기 때문이다.
fn is_safe_segment(seg: &str) -> bool {
    let mut bytes = seg.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `str::parse` 가 받아 주는 `+7` 같은 표기를 막는다 — 같은 값에 여러 표기가 있으면
/// 세션 토큰과 offset 을 짝지어 보는 판정이 표기 차이로 어긋날 수 있다.
fn parse_u64(raw: &str) -> Option<u64> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

/// PTY 크기(u16) 파서. `parse_u64` 와 같은 규율에 0 을 더해 거른다 — 0열·0행은
/// 크기가 아니라 부재이고, 하한 클램프가 그 실수를 조용히 20열로 바꿔 주면
/// 클라이언트는 자기 계산이 틀렸다는 사실을 영영 모른다.
fn parse_u16(raw: &str) -> Option<u16> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value: u16 = raw.parse().ok()?;
    (value > 0).then_some(value)
}

/// `key=value&…` 최소 파서. 퍼센트 디코딩도 `+` → 공백 변환도 하지 않는다: 우리가 읽는
/// 두 값(`since`·`session`)은 우리 페이지가 만들고 둘 다 인코딩이 필요 없는 문자만 쓴다.
fn query_param<'a>(query: Option<&'a str>, key: &str) -> Option<&'a str> {
    query?.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (k == key).then_some(v)
    })
}

/// 세션 토큰은 서버가 만든 `<epoch>:<id>` 이지만 이 모듈은 그 모양을 검사하지 않는다 —
/// 불투명 값으로 날라 주고, 현재 토큰과 같은지만 핸들러가 본다.
fn session_param(query: Option<&str>) -> Option<String> {
    match query_param(query, "session") {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(path: &str, query: Option<&str>) -> Route {
        route(Method::Get, path, query)
    }

    #[test]
    fn routes_state_screen_and_input() {
        assert_eq!(get("/api/state", None), Route::State);
        assert_eq!(
            get("/api/tabs/12/screen", None),
            Route::Screen {
                tab: 12,
                since: None,
                session: None,
            }
        );
        assert_eq!(
            route(Method::Post, "/api/tabs/12/input", None),
            Route::Input {
                tab: 12,
                session: None,
            }
        );
    }

    #[test]
    fn unknown_path_is_not_found() {
        for path in [
            "/api",
            "/api/",
            "/api/states",
            "/api/tabs/12",
            "/api/tabs/12/screen/extra",
            "/api/tabs/abc/screen",
            "/api/tabs//screen",
            "/state.json",
            "remote/index.html",
        ] {
            assert_eq!(get(path, None), Route::NotFound, "path = {path}");
        }
    }

    #[test]
    fn options_is_not_found() {
        for path in ["/", "/api/state", "/api/tabs/1/input", "/remote/index.html"] {
            assert_eq!(
                route(Method::Other, path, None),
                Route::NotFound,
                "path = {path}"
            );
        }
    }

    #[test]
    fn a_post_to_a_get_route_is_not_found() {
        assert_eq!(route(Method::Post, "/api/state", None), Route::NotFound);
        assert_eq!(
            route(Method::Post, "/api/tabs/1/screen", None),
            Route::NotFound
        );
        assert_eq!(route(Method::Post, "/", None), Route::NotFound);
        assert_eq!(
            route(Method::Post, "/remote/index.html", None),
            Route::NotFound
        );
        assert_eq!(get("/api/tabs/1/input", None), Route::NotFound);
    }

    #[test]
    fn root_maps_to_the_remote_index() {
        assert_eq!(
            get("/", None),
            Route::Static {
                key: "remote/index.html".to_string(),
            }
        );
    }

    #[test]
    fn a_hashed_asset_name_with_dots_is_accepted() {
        assert_eq!(
            get("/remote/assets/index-D4f8a1b2.js", None),
            Route::Static {
                key: "remote/assets/index-D4f8a1b2.js".to_string(),
            }
        );
        assert_eq!(
            get("/remote/index.html", None),
            Route::Static {
                key: "remote/index.html".to_string(),
            }
        );
    }

    #[test]
    fn a_dotfile_segment_is_rejected() {
        assert_eq!(get("/remote/.env", None), Route::NotFound);
        assert_eq!(get("/remote/assets/.hidden.js", None), Route::NotFound);
    }

    #[test]
    fn a_parent_segment_is_rejected() {
        for path in [
            "/remote/../state.json",
            "/remote/assets/../../state.json",
            "/remote/./index.html",
            "/remote//index.html",
            "/remote/",
            "/remote",
            "/remote/assets\\index.js",
        ] {
            assert_eq!(get(path, None), Route::NotFound, "path = {path}");
        }
    }

    #[test]
    fn a_percent_escape_in_a_static_path_is_rejected() {
        for path in [
            "/remote/%2e%2e/state.json",
            "/remote/%2E%2E%2Fstate.json",
            "/remote/index%2ehtml",
        ] {
            assert_eq!(get(path, None), Route::NotFound, "path = {path}");
        }
    }

    #[test]
    fn since_parses_and_garbage_is_a_bad_request() {
        assert_eq!(
            get("/api/tabs/3/screen", Some("since=1024")),
            Route::Screen {
                tab: 3,
                since: Some(1024),
                session: None,
            }
        );
        for query in ["since=abc", "since=", "since=-1", "since=+1", "since=1.5"] {
            assert_eq!(
                get("/api/tabs/3/screen", Some(query)),
                Route::BadRequest,
                "query = {query}"
            );
        }
        assert_eq!(
            get("/api/tabs/3/screen", Some("other=1")),
            Route::Screen {
                tab: 3,
                since: None,
                session: None,
            }
        );
    }

    #[test]
    fn resize_carries_the_mode_and_the_mobile_size() {
        assert_eq!(
            route(
                Method::Post,
                "/api/tabs/9/resize",
                Some("mode=mobile&cols=48&rows=57&session=1:4")
            ),
            Route::Resize {
                tab: 9,
                session: Some("1:4".to_string()),
                mode: ResizeMode::Mobile { cols: 48, rows: 57 },
            }
        );
        assert_eq!(
            route(Method::Post, "/api/tabs/9/resize", Some("mode=desktop")),
            Route::Resize {
                tab: 9,
                session: None,
                mode: ResizeMode::Desktop,
            }
        );
    }

    #[test]
    fn resize_with_a_broken_query_is_a_bad_request() {
        for query in [
            "",
            "mode=",
            "mode=mobil",
            "mode=MOBILE&cols=48&rows=57",
            "mode=mobile",
            "mode=mobile&cols=48",
            "mode=mobile&rows=57",
            "mode=mobile&cols=&rows=57",
            "mode=mobile&cols=0&rows=57",
            "mode=mobile&cols=-1&rows=57",
            "mode=mobile&cols=48&rows=+57",
            "mode=mobile&cols=48&rows=1.5",
            // u16 상한 초과 — 절단해서 받으면 클라이언트가 요청한 크기와 달라진다.
            "mode=mobile&cols=65536&rows=57",
            "mode=mobile&cols=48&rows=99999",
        ] {
            assert_eq!(
                route(Method::Post, "/api/tabs/9/resize", Some(query)),
                Route::BadRequest,
                "query = {query}"
            );
        }
    }

    #[test]
    fn resize_is_post_only_and_unknown_tabs_are_not_found() {
        assert_eq!(
            get("/api/tabs/9/resize", Some("mode=desktop")),
            Route::NotFound
        );
        assert_eq!(
            route(Method::Post, "/api/tabs/abc/resize", Some("mode=desktop")),
            Route::NotFound
        );
    }

    #[test]
    fn session_is_carried_as_an_opaque_string() {
        assert_eq!(
            get("/api/tabs/3/screen", Some("since=7&session=17493:4")),
            Route::Screen {
                tab: 3,
                since: Some(7),
                session: Some("17493:4".to_string()),
            }
        );
        assert_eq!(
            route(
                Method::Post,
                "/api/tabs/3/input",
                Some("session=not:a:number")
            ),
            Route::Input {
                tab: 3,
                session: Some("not:a:number".to_string()),
            }
        );
        assert_eq!(
            route(Method::Post, "/api/tabs/3/input", Some("session=")),
            Route::Input {
                tab: 3,
                session: None,
            }
        );
    }
}
