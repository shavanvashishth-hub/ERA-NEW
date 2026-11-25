import { ExternalLink, Sparkles, Check, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { BrowserActionEvent } from '../types/era';

interface ActionToastProps {
  action: BrowserActionEvent | null;
  accentColor: string;
  onDismiss: () => void;
}

export function ActionToast({ action, accentColor, onDismiss }: ActionToastProps) {
  return (
    <AnimatePresence>
      {action && (
        <motion.div
          key={action.id}
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.97 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="fixed top-16 left-1/2 -translate-x-1/2 z-40 w-[min(92vw,420px)] rounded-2xl bg-[#111118]/92 backdrop-blur-xl border border-white/10 px-4 py-3 shadow-2xl"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06]"
                style={{ color: accentColor }}
              >
                {action.url ? (
                  <ExternalLink className="w-4 h-4" />
                ) : action.toolName === 'copyToClipboard' ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{action.title}</p>
                <p className="text-xs text-white/55 truncate">{action.detail}</p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {action.url && (
                <a
                  href={action.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center min-h-[40px] px-3 rounded-xl text-xs font-medium text-white bg-white/10 hover:bg-white/15 transition-colors whitespace-nowrap"
                >
                  Open
                </a>
              )}
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss action notification"
                className="inline-flex items-center justify-center min-h-[40px] min-w-[40px] rounded-xl text-white/50 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
