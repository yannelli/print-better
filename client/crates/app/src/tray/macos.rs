//! macOS menu-bar item (objc2 NSStatusItem) with an SF Symbol template icon.

use super::menu::{self, Action, Model};
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::NSObject;
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSImage, NSMenu, NSMenuItem, NSStatusBar, NSStatusItem,
    NSVariableStatusItemLength,
};
use objc2_foundation::{NSString, ns_string};
use std::cell::RefCell;

struct Ivars {
    in_process: bool,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and `Target` does not implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "PrintBetterTrayTarget"]
    #[ivars = Ivars]
    struct Target;

    impl Target {
        #[unsafe(method(menuAction:))]
        fn menu_action(&self, sender: &NSMenuItem) {
            let Some(action) = Action::from_tag(sender.tag()) else { return };
            let in_process = self.ivars().in_process;
            if action == Action::Quit && !in_process {
                NSApplication::sharedApplication(self.mtm()).terminate(None);
                return;
            }
            menu::perform(action, in_process);
        }
    }
);

impl Target {
    fn new(mtm: MainThreadMarker, in_process: bool) -> Retained<Target> {
        let this = Target::alloc(mtm).set_ivars(Ivars { in_process });
        // SAFETY: NSObject's designated initializer, called once on a fresh allocation.
        unsafe { msg_send![super(this), init] }
    }
}

struct Ui {
    item: Retained<NSStatusItem>,
    target: Retained<Target>,
}

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
}

/// Blocks the main thread in the AppKit run loop.
pub fn run(in_process: bool) {
    let Some(mtm) = MainThreadMarker::new() else {
        log::error!("the menu bar icon must run on the main thread");
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let item = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
    if let Some(button) = item.button(mtm) {
        let symbol =
            NSImage::imageWithSystemSymbolName_accessibilityDescription(ns_string!("printer"), Some(ns_string!("Print Better")));
        match symbol {
            Some(image) => {
                image.setTemplate(true);
                button.setImage(Some(&image));
            }
            None => button.setTitle(ns_string!("Print Better")),
        }
    }
    UI.with(|ui| *ui.borrow_mut() = Some(Ui { item, target: Target::new(mtm, in_process) }));
    render(mtm, &Model::not_running());
    menu::poll(|model| {
        DispatchQueue::main().exec_async(move || {
            if let Some(mtm) = MainThreadMarker::new() {
                render(mtm, &model);
            }
        })
    });
    app.run();
}

fn render(mtm: MainThreadMarker, model: &Model) {
    UI.with(|ui| {
        let ui = ui.borrow();
        let Some(ui) = ui.as_ref() else { return };
        ui.item.setVisible(model.visible);
        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);
        menu.addItem(&info_item(mtm, &model.status));
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        if model.printers.is_empty() {
            menu.addItem(&info_item(mtm, "No printers added yet"));
        }
        for line in model.printers.iter().chain(&model.remote_problem) {
            menu.addItem(&info_item(mtm, line));
        }
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        for action in Action::MENU.into_iter().filter(|a| a.shown(model)) {
            if action == Action::HideIcon {
                menu.addItem(&NSMenuItem::separatorItem(mtm));
            }
            let enabled = action != Action::OpenDashboard || model.dashboard.is_some();
            menu.addItem(&action_item(mtm, &ui.target, action, model, enabled));
        }
        ui.item.setMenu(Some(&menu));
        if let Some(button) = ui.item.button(mtm) {
            button.setToolTip(Some(&NSString::from_str(&format!("Print Better: {}", model.status))));
        }
    });
}

fn info_item(mtm: MainThreadMarker, title: &str) -> Retained<NSMenuItem> {
    // SAFETY: no action selector, so nothing is ever sent to a target.
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(mtm.alloc(), &NSString::from_str(title), None, ns_string!(""))
    };
    item.setEnabled(false);
    item
}

fn action_item(mtm: MainThreadMarker, target: &Target, action: Action, model: &Model, enabled: bool) -> Retained<NSMenuItem> {
    let key = if action == Action::Quit { ns_string!("q") } else { ns_string!("") };
    let title = NSString::from_str(&action.label(model));
    // SAFETY: `menuAction:` is defined on `Target` with the (sender) signature AppKit uses.
    let item = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(mtm.alloc(), &title, Some(sel!(menuAction:)), key) };
    // SAFETY: the target outlives the menu; it is kept in `UI` for the life of the app.
    unsafe { item.setTarget(Some(target)) };
    item.setTag(action.tag());
    item.setEnabled(enabled);
    item
}
