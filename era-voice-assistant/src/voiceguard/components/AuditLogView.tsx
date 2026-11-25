import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import type { AuditLogEntry } from '../types';

interface AuditLogViewProps {
  entries: AuditLogEntry[];
  isUnlocked: boolean;
  onClearLog: () => void;
}

export function AuditLogView({ entries, isUnlocked, onClearLog }: AuditLogViewProps) {
  const [filter, setFilter] = useState<'all' | 'verified' | 'rejected'>('all');

  const filtered = entries.filter((entry) => {
    if (filter === 'verified') return entry.isVerifiedOwner;
    if (filter === 'rejected') return !entry.isVerifiedOwner;
    return true;
  });

  const handleExportCsv = () => {
    const header = ['Timestamp', 'Verdict', 'Combined%', 'DSP%', 'AI%', 'ProbePitchHz', 'PitchDeltaHz', 'Source', 'Transcript', 'Analysis'];
    const rows = filtered.map((e) => [
      e.timestamp,
      e.verdict,
      String(e.combinedConfidence),
      String(e.dspScore),
      String(e.aiConfidence),
      String(e.probePitchHz),
      String(e.pitchDeltaHz),
      e.source,
      `"${e.transcript.replace(/"/g, '""')}"`,
      `"${e.analysis.replace(/"/g, '""')}"`,
    ]);
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voiceguard-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-slate-100">Security &amp; Intruder Audit Log</h2>
          <p className="text-xs font-mono text-slate-400 tabular-nums">
            Total Events: {entries.length} · Blocked Intruders: {entries.filter((e) => !e.isVerifiedOwner).length}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-[#0F141D] border border-slate-800 rounded-md">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                filter === 'all' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setFilter('verified')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                filter === 'verified' ? 'bg-slate-800 text-emerald-300' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Owner Verified
            </button>
            <button
              type="button"
              onClick={() => setFilter('rejected')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                filter === 'rejected' ? 'bg-slate-800 text-rose-300' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Intruder Blocked
            </button>
          </div>

          <button
            type="button"
            disabled={filtered.length === 0}
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-700 rounded-md hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>

          {isUnlocked && entries.length > 0 && (
            <button
              type="button"
              onClick={onClearLog}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-300 border border-rose-500/30 rounded-md hover:bg-rose-950/40 transition-colors whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Log
            </button>
          )}
        </div>
      </div>

      <div className="border border-slate-800 bg-[#0F141D] rounded-lg overflow-x-auto">
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No verification events match this filter yet.
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs font-mono text-slate-400">
                <th className="py-3 px-4 font-medium">Timestamp</th>
                <th className="py-3 px-4 font-medium">Verdict</th>
                <th className="py-3 px-4 font-medium text-right">Match %</th>
                <th className="py-3 px-4 font-medium text-right">Probe F0</th>
                <th className="py-3 px-4 font-medium text-right">Pitch Δ</th>
                <th className="py-3 px-4 font-medium">Transcript</th>
                <th className="py-3 px-4 font-medium">Forensic Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-xs">
              {filtered.map((entry) => (
                <tr key={entry.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-3 px-4 font-mono text-slate-400 whitespace-nowrap tabular-nums">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </td>
                  <td
                    className={`py-3 px-4 font-mono font-semibold whitespace-nowrap ${
                      entry.isVerifiedOwner ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {entry.verdict}
                  </td>
                  <td className="py-3 px-4 font-mono text-right text-slate-200 tabular-nums">
                    {entry.combinedConfidence}%
                  </td>
                  <td className="py-3 px-4 font-mono text-right text-slate-300 tabular-nums">
                    {entry.probePitchHz} Hz
                  </td>
                  <td className="py-3 px-4 font-mono text-right text-slate-300 tabular-nums">
                    {entry.pitchDeltaHz} Hz
                  </td>
                  <td className="py-3 px-4 text-slate-200 max-w-xs truncate" title={entry.transcript}>
                    “{entry.transcript}”
                  </td>
                  <td className="py-3 px-4 text-slate-400 max-w-sm truncate" title={entry.analysis}>
                    {entry.analysis}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
