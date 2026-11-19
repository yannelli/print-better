//! Linux StatusNotifierItem tray over D-Bus (ksni); KDE, and GNOME with the AppIndicator extension.

use super::menu::{self, Action, Model};
use ksni::menu::StandardItem;
use ksni::{Handle, MenuItem, ToolTip, Tray, TrayMethods};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::mpsc;

struct PrintBetterTray {
    model: Model,
    in_process: bool,
    quit: Arc<AtomicBool>,
}

impl Tray for PrintBetterTray {
    const MENU_ON_ACTIVATE: bool = true;

    fn id(&self) -> String {
        "printbetter".into()
    }

    fn title(&self) -> String {
        "Print Better".into()
    }

    fn icon_name(&self) -> String {
        "printer".into()
    }

    fn tool_tip(&self) -> ToolTip {
        ToolTip { title: "Print Better".into(), description: self.model.status.clone(), ..ToolTip::default() }
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        let mut items = vec![info(&self.model.status), MenuItem::Separator];
        if self.model.printers.is_empty() {
            items.push(info("No printers added yet"));
        }
        items.extend(self.model.printers.iter().chain(&self.model.remote_problem).map(|line| info(line)));
        items.push(MenuItem::Separator);
        for action in Action::MENU.into_iter().filter(|a| a.shown(&self.model)) {
            if action == Action::HideIcon {
                items.push(MenuItem::Separator);
            }
            let item = StandardItem {
                label: action.label(&self.model).replace('_', "__"),
                enabled: action != Action::OpenDashboard || self.model.dashboard.is_some(),
                activate: Box::new(move |tray: &mut PrintBetterTray| tray.choose(action)),
                ..StandardItem::default()
            };
            items.push(item.into());
        }
        items
    }
}

impl PrintBetterTray {
    fn choose(&mut self, action: Action) {
        if action == Action::Quit && !self.in_process {
            self.quit.store(true, Ordering::SeqCst);
            return;
        }
        menu::perform(action, self.in_process);
    }
}

fn info(label: &str) -> MenuItem<PrintBetterTray> {
    StandardItem { label: label.replace('_', "__"), enabled: false, ..StandardItem::default() }.into()
}

pub fn run(in_process: bool) {
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(e) => {
            log::error!("tray: could not start: {e}");
            return;
        }
    };
    let (tx, mut models) = mpsc::unbounded_channel();
    menu::poll(move |model| {
        let _ = tx.send(model);
    });
    let quit = Arc::new(AtomicBool::new(false));
    runtime.block_on(async move {
        let mut handle: Option<Handle<PrintBetterTray>> = None;
        let mut warned = false;
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
        let mut model = Model::not_running();
        while !quit.load(Ordering::SeqCst) {
            tokio::select! {
                Some(next) = models.recv() => model = next,
                _ = ticker.tick() => {}
            }
            match (&handle, model.visible) {
                (None, true) => {
                    let tray = PrintBetterTray { model: model.clone(), in_process, quit: quit.clone() };
                    match tray.spawn().await {
                        Ok(spawned) => handle = Some(spawned),
                        Err(e) if !warned => {
                            log::warn!("tray icon unavailable (no StatusNotifier host?): {e}");
                            warned = true;
                        }
                        Err(_) => {}
                    }
                }
                (Some(shown), true) => {
                    let next = model.clone();
                    shown.update(move |tray| tray.model = next).await;
                }
                (Some(shown), false) => {
                    shown.shutdown().await;
                    handle = None;
                }
                (None, false) => {}
            }
        }
        if let Some(shown) = handle {
            shown.shutdown().await;
        }
    });
}
