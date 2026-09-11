//! mast spike — Tauri v2 부팅부. 로직은 commands/sink/state 모듈에 있고
//! 여기서는 상태 등록과 커맨드 핸들러 배선만 한다 (spike-plan 4.5).

// Windows 릴리스 빌드에서 콘솔 창을 띄우지 않는다 (디버그 빌드는 콘솔 유지).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod sink;
mod state;

fn main() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_terminal,
            commands::write_stdin,
            commands::send_raw,
            commands::resize,
            commands::ack_output,
            commands::replay,
            commands::close_terminal,
            commands::get_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mast-spike");
}
