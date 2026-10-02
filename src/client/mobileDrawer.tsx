import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import drawerCss from "./mobileDrawer.css";

const MOBILE_QUERY = "(max-width: 859px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type DrawerPhase = "entering" | "open" | "closing";
type HandleDrag = { pointerId: number; startX: number; startY: number; startOffset: number; offset: number };

export function useMobileViewport(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return mobile;
}

export function containDialogFocus(event: React.KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const dialog = event.currentTarget;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    "button, a[href], input, select, textarea, [tabindex]",
  )).filter(element => element.tabIndex >= 0
    && !element.matches(":disabled")
    && !element.closest("[inert]")
    && element.getClientRects().length > 0
    && getComputedStyle(element).visibility === "visible")
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!first || !last) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
  } else if (!focusable.includes(active as HTMLElement) || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
}

export function ResponsiveMenu({ open, onClose, label, children }: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const mobile = useMobileViewport();
  const [present, setPresent] = useState(mobile && open);
  const [phase, setPhase] = useState<DrawerPhase>("entering");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<DrawerPhase>("entering");
  const onCloseRef = useRef(onClose);
  const framesRef = useRef<number[]>([]);
  const closeTimerRef = useRef<number | null>(null);
  const dragRef = useRef<HandleDrag | null>(null);
  const suppressClickRef = useRef(false);
  const backdropPointerRef = useRef(false);
  onCloseRef.current = onClose;

  const cancelAnimationWork = useCallback(() => {
    framesRef.current.forEach(cancelAnimationFrame);
    framesRef.current = [];
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const resetDrag = useCallback(() => {
    dragRef.current = null;
    const sheet = sheetRef.current;
    if (sheet) {
      delete sheet.dataset.dragging;
      sheet.style.setProperty("--pf-drawer-offset", "0px");
    }
  }, []);

  const beginClose = useCallback(() => {
    if (!dialogRef.current?.open || phaseRef.current === "closing") return;
    cancelAnimationWork();
    resetDrag();
    phaseRef.current = "closing";
    setPhase("closing");
    // transitionend is the normal completion path; the deadline also covers
    // reduced motion, interrupted transitions, and a backgrounded document.
    const delay = window.matchMedia(REDUCED_MOTION_QUERY).matches ? 0 : 280;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setPresent(false);
    }, delay);
  }, [cancelAnimationWork, resetDrag]);

  const requestClose = useCallback(() => {
    if (!dialogRef.current?.open || phaseRef.current === "closing") return;
    beginClose();
    onCloseRef.current();
  }, [beginClose]);

  useLayoutEffect(() => {
    if (!mobile || !present) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    phaseRef.current = "entering";
    setPhase("entering");
    dialog.showModal();
    // Two frames leave an initial off-screen frame before the transition starts.
    framesRef.current.push(requestAnimationFrame(() => {
      framesRef.current.push(requestAnimationFrame(() => {
        framesRef.current = [];
        phaseRef.current = "open";
        setPhase("open");
      }));
    }));

    return () => {
      cancelAnimationWork();
      resetDrag();
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [mobile, present, cancelAnimationWork, resetDrag]);

  useEffect(() => {
    if (!mobile) {
      setPresent(false);
      return;
    }
    if (!open) {
      beginClose();
    } else if (!present) {
      setPresent(true);
    } else if (phaseRef.current === "closing") {
      cancelAnimationWork();
      resetDrag();
      phaseRef.current = "open";
      setPhase("open");
    }
  }, [mobile, open, present, beginClose, cancelAnimationWork, resetDrag]);

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0 || phaseRef.current !== "open") return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    // Continue from the visible position even if a previous snap is unfinished.
    const startOffset = Math.max(0, new DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42);
    suppressClickRef.current = false;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startOffset, offset: startOffset };
    sheet.dataset.dragging = "true";
    sheet.style.setProperty("--pf-drawer-offset", `${startOffset}px`);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = event.clientY - drag.startY;
    if (Math.abs(distance) > 6 || Math.abs(event.clientX - drag.startX) > 6) suppressClickRef.current = true;
    drag.offset = Math.max(0, drag.startOffset + distance);
    sheetRef.current?.style.setProperty("--pf-drawer-offset", `${drag.offset}px`);
  }

  function finishDrag(event: React.PointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const threshold = Math.min(140, (sheetRef.current?.getBoundingClientRect().height ?? 560) * 0.25);
    const dismiss = !cancelled && suppressClickRef.current && drag.offset >= threshold;
    resetDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) suppressClickRef.current = true;
    if (dismiss) requestClose();
  }

  if (!mobile) return open ? <>{children}</> : null;
  if (!present) return null;

  return createPortal(<>
    <style>{drawerCss}</style>
    <dialog
      ref={dialogRef}
      className="pf-mobile-drawer"
      data-phase={phase}
      aria-label={label}
      onKeyDown={containDialogFocus}
      onCancel={event => { event.preventDefault(); requestClose(); }}
      onPointerDown={event => { backdropPointerRef.current = event.target === event.currentTarget; }}
      onPointerCancel={() => { backdropPointerRef.current = false; }}
      onClick={event => {
        if (event.target === event.currentTarget && backdropPointerRef.current) requestClose();
        backdropPointerRef.current = false;
      }}
    >
      <div
        ref={sheetRef}
        className="pf-mobile-drawer-sheet"
        onTransitionEnd={event => {
          if (event.target === event.currentTarget && event.propertyName === "transform" && phaseRef.current === "closing") {
            cancelAnimationWork();
            setPresent(false);
          }
        }}
      >
        <button
          type="button"
          className="pf-mobile-drawer-handle"
          aria-label={`Close ${label}`}
          onClick={event => {
            if (event.detail === 0 || !suppressClickRef.current) requestClose();
            suppressClickRef.current = false;
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={event => finishDrag(event, false)}
          onPointerCancel={event => finishDrag(event, true)}
          onLostPointerCapture={event => finishDrag(event, true)}
        >
          <span aria-hidden="true" />
        </button>
        <div className="pf-mobile-drawer-content">{children}</div>
      </div>
    </dialog>
  </>, document.body);
}
