"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CloudLightning, FlaskConical, RotateCcw, Wrench } from "lucide-react";
import { useReadyState } from "@/components/providers/UrvaraProvider";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button, Panel } from "@/components/ui/primitives";
import { DEMO_BREAKDOWN_MACHINE, simulateMachineBreakdown, simulateWeatherChange } from "@/services/scenario";

/**
 * Repeatable incidents for judging. Each button changes real state through the
 * same services a real forecast feed or breakdown report would use.
 */
export function DemoIncidents({ compact = false }: { compact?: boolean }) {
  const { state, user, run, reset } = useReadyState();
  const router = useRouter();
  const [confirmReset, setConfirmReset] = useState(false);
  const machine = state.resources.find((r) => r.id === DEMO_BREAKDOWN_MACHINE);
  const weatherDone = state.scenario.weatherChanged;
  const machineDone = machine?.status !== "available";

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <FlaskConical aria-hidden className="size-4 text-gold-ink" />
          Demo incidents
        </span>
      }
      description={compact ? undefined : "Trigger a real event in the synthetic scenario and watch Urvara coordinate the response. Reset to replay."}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col rounded-control border border-line p-3">
          <p className="font-semibold text-ink-strong">Forecast flips to rain</p>
          <p className="mt-0.5 flex-1 text-sm text-ink">Thunderstorms Thu afternoon to Fri morning over Dindori and Niphad. Sprays, fertiliser and irrigation get replanned.</p>
          <Button
            className="mt-3 self-start"
            variant={weatherDone ? "secondary" : "gold"}
            icon={CloudLightning}
            disabled={weatherDone}
            onClick={async () => {
              let id: string | undefined;
              const ok = await run((s) => {
                const r = simulateWeatherChange(s, user.id);
                id = r.proposalId;
                return r.state;
              }, { success: "Forecast updated. A replan is waiting for your approval." });
              if (ok && id) router.push(⁠ /owner/operations?proposal=${id} ⁠);
            }}
          >
            {weatherDone ? "Forecast already updated" : "Simulate rain"}
          </Button>
        </div>
        <div className="flex flex-col rounded-control border border-line p-3">
          <p className="font-semibold text-ink-strong">{machine?.name} breaks down</p>
          <p className="mt-0.5 flex-1 text-sm text-ink">Its bookings across three farms are moved to the other sprayer where possible; the rest are flagged for you.</p>
          <Button
            className="mt-3 self-start"
            variant={machineDone ? "secondary" : "gold"}
            icon={Wrench}
            disabled={machineDone}
            onClick={async () => {
              let id: string | undefined;
              const ok = await run((s) => {
                const r = simulateMachineBreakdown(s, user.id);
                id = r.proposalId;
                return r.state;
              }, { success: ⁠ ${machine?.name} marked broken. A replan is waiting for your approval. ⁠ });
              if (ok && id) router.push(⁠ /owner/operations?proposal=${id} ⁠);
            }}
          >
            {machineDone ? "Already out of service" : "Break the sprayer"}
          </Button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => setConfirmReset(true)}>
          Reset demo scenario
        </Button>
        <p className="text-sm text-ink-muted">Restores every farm, task, report and score to the starting story.</p>
      </div>
      <ConfirmDialog
        open={confirmReset}
        title="Reset the demo scenario?"
        confirmLabel="Reset everything"
        tone="danger"
        onClose={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          void reset();
        }}
      >
        All changes made during this demo (reports, approvals, new farmers, corrections) will be replaced by the original synthetic scenario. Signed-in sessions stay signed in.
      </ConfirmDialog>
    </Panel>
  );
}