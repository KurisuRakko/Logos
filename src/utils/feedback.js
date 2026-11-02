import { installRippleFeedback } from '../../vendor/rakko-design/design-system/src/ripple.js';
import { installPressFeedback } from '../../vendor/rakko-design/react/src/press/press';
import { MOTION } from '../../vendor/rakko-design/react/src/motion';
import '../../vendor/rakko-design/design-system/src/state-layer.css';

// Rakko Design: hover / focus 500ms before a tooltip shows
export const TOOLTIP_DELAY = MOTION.tooltipDelayMs;

// NextUI buttons (react-aria usePress) stop pointerdown at the React root, so the upstream
// bubble-phase delegations would never see them; hand them a root that listens in capture phase
function captureRoot(doc) {
    return {
        ownerDocument: doc,
        contains: (node) => doc.contains(node),
        addEventListener: (type, listener) => doc.addEventListener(type, listener, true),
        removeEventListener: (type, listener) => doc.removeEventListener(type, listener, true),
    };
}

// Every button is a ripple surface; marking them here (before pointerdown / keydown reaches the
// ripple delegation) saves putting data-ripple on each of the NextUI <Button>s by hand.
// Buttons without text are icon buttons and ripple from the center.
function markButton(event) {
    const button = event.target?.closest?.('button');
    if (!button || button.hasAttribute('data-ripple') || button.hasAttribute('data-no-ripple')) return;
    button.setAttribute('data-ripple', '');
    if (button.textContent.trim() === '') {
        button.setAttribute('data-ripple-centered', '');
    }
}

// Install ripple and press feedback once for the whole window; returns the disposer
export function installFeedback(doc = document) {
    doc.addEventListener('pointerover', markButton, true);
    doc.addEventListener('focusin', markButton, true);
    const root = captureRoot(doc);
    const disposeRipple = installRippleFeedback(root);
    const disposePress = installPressFeedback(root);
    return () => {
        doc.removeEventListener('pointerover', markButton, true);
        doc.removeEventListener('focusin', markButton, true);
        disposeRipple();
        disposePress();
    };
}
