import { useLayoutEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { containDialogFocus, useMobileViewport } from "./mobileDrawer.tsx";
import navigationStyles from "./mobileNavigation.css";

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  distance: number;
  dragging: boolean;
};

type SidebarPhase = "closed" | "preview" | "opening" | "open" | "closing";

export function ResponsiveSidebar({ open, onOpen, onClose, children }: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const mobile = useMobileViewport();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const edgeRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<SidebarPhase>("closed");
  const gestureRef = useRef<Gesture | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const callbacksRef = useRef({ onOpen, onClose });
  const openRef = useRef(open);
  callbacksRef.current = { onOpen, onClose };
  openRef.current = open;

  function rememberOpener() {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  function restoreFocus() {
    const opener = openerRef.current;
    openerRef.current = null;
    const settings = document.querySelector<HTMLElement>('.pf-settings-dialog[role="dialog"]');
    if (settings?.getClientRects().length) {
      settings.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')?.focus({ preventScroll: true });
      return;
    }
    const target = opener?.isConnected && opener.getClientRects().length
      ? opener
      : document.querySelector<HTMLElement>('button[aria-label="Open sidebar"]');
    target?.focus({ preventScroll: true });
  }

  function stopAnimation() {
    const dialog = dialogRef.current;
    if (dialog && animationRef.current) {
      dialog.style.transform = getComputedStyle(dialog).transform;
      animationRef.current.cancel();
      animationRef.current = null;
    }
  }

  function settle(transform: string, complete: () => void) {
    const dialog = dialogRef.current;
    if (!dialog) return;
    stopAnimation();
    const from = getComputedStyle(dialog).transform;
    dialog.style.transform = transform;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      complete();
      return;
    }
    const animation = dialog.animate(
      [{ transform: from }, { transform }],
      { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    animationRef.current = animation;
    animation.onfinish = () => {
      if (animationRef.current !== animation) return;
      animationRef.current = null;
      animation.cancel();
      complete();
    };
  }

  function closeImmediately() {
    const dialog = dialogRef.current;
    if (!dialog) return;
    stopAnimation();
    const wasVisible = dialog.open;
    dialog.inert = true;
    dialog.removeAttribute("data-active");
    dialog.setAttribute("aria-hidden", "true");
    dialog.style.transform = "translateX(-100%)";
    phaseRef.current = "closed";
    if (dialog.open) dialog.close();
    if (wasVisible) restoreFocus();
  }

  function closeAnimated() {
    const dialog = dialogRef.current;
    if (!dialog?.open || phaseRef.current === "closing") return;
    dialog.inert = true;
    dialog.removeAttribute("data-active");
    phaseRef.current = "closing";
    settle("translateX(-100%)", closeImmediately);
  }

  function releaseGesture() {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (gesture && edgeRef.current?.hasPointerCapture(gesture.pointerId)) {
      edgeRef.current.releasePointerCapture(gesture.pointerId);
    }
    return gesture;
  }

  useLayoutEffect(() => {
    if (!mobile) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.inert = true;
    dialog.setAttribute("aria-hidden", "true");
    const onResize = () => {
      const gesture = releaseGesture();
      if (gesture?.dragging || phaseRef.current === "preview") closeImmediately();
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      releaseGesture();
      // The element may already have been detached by a breakpoint change.
      animationRef.current?.cancel();
      animationRef.current = null;
      const wasVisible = dialog.open;
      if (dialog.open) dialog.close();
      phaseRef.current = "closed";
      if (wasVisible) restoreFocus();
    };
  }, [mobile]);

  useLayoutEffect(() => {
    if (!mobile) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) {
      if (phaseRef.current !== "preview") closeAnimated();
      return;
    }
    if (phaseRef.current === "open" || phaseRef.current === "opening") return;
    releaseGesture();
    stopAnimation();
    if (phaseRef.current === "closed") rememberOpener();
    // A nonmodal preview must be closed before promotion to the top layer.
    if (phaseRef.current === "preview" && dialog.open) dialog.close();
    dialog.inert = false;
    dialog.removeAttribute("aria-hidden");
    dialog.setAttribute("data-active", "");
    if (!dialog.open) dialog.showModal();
    phaseRef.current = "opening";
    settle("translateX(0)", () => { phaseRef.current = "open"; });
  }, [mobile, open]);

  function startGesture(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || openRef.current || dialogRef.current?.open) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: window.innerWidth,
      distance: 0,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    const dialog = dialogRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !dialog) return;
    const x = event.clientX - gesture.startX;
    const y = Math.abs(event.clientY - gesture.startY);
    if (x < -8 || (y > 10 && y > Math.abs(x))) {
      releaseGesture();
      if (gesture.dragging) closeAnimated();
      return;
    }
    if (!gesture.dragging) {
      if (x < 8 || x < y * 1.25) return;
      rememberOpener();
      dialog.inert = true;
      dialog.setAttribute("aria-hidden", "true");
      dialog.show();
      // Previewing navigation must not steal focus from the chat.
      openerRef.current?.focus({ preventScroll: true });
      phaseRef.current = "preview";
      gesture.dragging = true;
    }
    event.preventDefault();
    gesture.distance = Math.max(0, Math.min(x, gesture.width));
    dialog.style.transform = `translateX(${gesture.distance - gesture.width}px)`;
  }

  function finishGesture(event: PointerEvent<HTMLDivElement>, cancelled: boolean) {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    const gesture = releaseGesture();
    if (!gesture?.dragging) return;
    if (!cancelled && gesture.distance >= Math.min(100, gesture.width * 0.25)) {
      callbacksRef.current.onOpen();
    } else {
      closeAnimated();
    }
  }

  if (!mobile) return <>{children}</>;

  return createPortal(<>
    <style>{navigationStyles}</style>
    <div
      ref={edgeRef}
      className="pf-mobile-navigation-edge"
      aria-hidden="true"
      hidden={open}
      onPointerDown={startGesture}
      onPointerMove={moveGesture}
      onPointerUp={(event) => finishGesture(event, false)}
      onPointerCancel={(event) => finishGesture(event, true)}
      onLostPointerCapture={(event) => finishGesture(event, true)}
    />
    <dialog
      ref={dialogRef}
      className="pf-mobile-navigation-dialog"
      aria-label="Navigation"
      onKeyDown={containDialogFocus}
      onCancel={(event) => {
        event.preventDefault();
        callbacksRef.current.onClose();
      }}
    >
      {children}
    </dialog>
  </>, document.body);
}
