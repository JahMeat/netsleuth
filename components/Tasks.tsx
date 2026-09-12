"use client";

import { useEffect, useRef, useState } from "react";
import { TASK_VERBS, type Task } from "@/lib/protocol";

/**
 * The task panel.
 *
 * Every interaction reports one unit of work to the server, which credits it
 * and emits packets from this player's IP. That is the point: your screen is
 * how you put traffic on the wire, and the shape of that traffic is identical
 * whether you are an analyst doing real work or a hacker faking it.
 *
 * This component does not know which you are, and deliberately so.
 */
export function TaskPanel({
  tasks,
  stalled,
  onWork,
}: {
  tasks: Task[];
  stalled: boolean;
  onWork: (taskId: string) => void;
}) {
  const done = tasks.filter((t) => t.done >= t.steps).length;

  return (
    <div className="panel taskPanel">
      <h2>
        Your tasks ({done}/{tasks.length})
      </h2>

      {stalled && (
        <div className="stallBanner">
          Network flooded — work is stalled. Wait it out.
        </div>
      )}

      <div className="taskList">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} disabled={stalled} onWork={() => onWork(t.id)} />
        ))}
      </div>

      <p className="hint">
        Doing a task puts packets on the wire from your address. Sitting still
        leaves a hole where your traffic should be.
      </p>
    </div>
  );
}

function TaskCard({
  task,
  disabled,
  onWork,
}: {
  task: Task;
  disabled: boolean;
  onWork: () => void;
}) {
  const complete = task.done >= task.steps;
  const pct = Math.round((Math.min(task.done, task.steps) / task.steps) * 100);

  return (
    <div className={`taskCard ${complete ? "complete" : ""}`}>
      <div className="taskHead">
        <span className="taskLabel">{task.label}</span>
        <span className="taskProgress">
          {complete ? "done" : `${task.done}/${task.steps}`}
        </span>
      </div>
      <div className="taskBarTrack">
        <div className="taskBarFill" style={{ width: `${pct}%` }} />
      </div>

      {!complete && (
        <>
          <p className="taskVerb">{TASK_VERBS[task.kind]}</p>
          {task.kind === "type" && (
            <TypeTask task={task} disabled={disabled} onWork={onWork} />
          )}
          {task.kind === "click" && <ClickTask task={task} disabled={disabled} onWork={onWork} />}
          {task.kind === "wind" && <WindTask disabled={disabled} onWork={onWork} />}
        </>
      )}
    </div>
  );
}

/** Type the phrase. Each fully typed word is one unit of work. */
function TypeTask({
  task,
  disabled,
  onWork,
}: {
  task: Task;
  disabled: boolean;
  onWork: () => void;
}) {
  const [text, setText] = useState("");
  const credited = useRef(0);

  // Server state is the truth; if it has credited more than we have, catch up
  // so a reconnect does not double-count or stall the input.
  useEffect(() => {
    if (task.done > credited.current) credited.current = task.done;
  }, [task.done]);

  const words = task.phrase.split(" ");

  function onChange(next: string) {
    setText(next);

    // Count how many leading words are typed correctly and fully.
    const typed = next.split(" ");
    let correct = 0;
    for (let i = 0; i < words.length; i++) {
      const isLast = i === typed.length - 1;
      if (typed[i] === undefined) break;
      if (typed[i] !== words[i]) break;
      // A word only counts once it is separated, or it is the final word.
      if (isLast && i < words.length - 1 && !next.endsWith(" ")) break;
      correct++;
    }

    while (credited.current < correct) {
      credited.current++;
      onWork();
    }
  }

  return (
    <>
      <p className="typeTarget">
        {words.map((w, i) => (
          <span key={i} className={i < task.done ? "typed" : ""}>
            {w}{" "}
          </span>
        ))}
      </p>
      <input
        className="taskInput"
        value={text}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="type it here"
        autoComplete="off"
        spellCheck={false}
      />
    </>
  );
}

/** Clear each alert. One click, one unit. */
function ClickTask({
  task,
  disabled,
  onWork,
}: {
  task: Task;
  disabled: boolean;
  onWork: () => void;
}) {
  const left = Math.max(0, task.steps - task.done);

  return (
    <div className="alertGrid">
      {Array.from({ length: left }, (_, i) => (
        <button key={i} className="alertChip" disabled={disabled} onClick={onWork}>
          ⚠ ack
        </button>
      ))}
    </div>
  );
}

/**
 * Wind the handle: drag to the end, it springs back, that is one turn. Chosen
 * because it produces a steady stream of work rather than a single click, which
 * is what a believable traffic trail needs.
 */
function WindTask({ disabled, onWork }: { disabled: boolean; onWork: () => void }) {
  const [v, setV] = useState(0);

  function change(next: number) {
    if (next >= 100) {
      onWork();
      setV(0);
      return;
    }
    setV(next);
  }

  return (
    <div className="windWrap">
      <input
        type="range"
        min={0}
        max={100}
        value={v}
        disabled={disabled}
        className="wind"
        onChange={(e) => change(Number(e.target.value))}
        onPointerUp={() => setV(0)}
        aria-label="Wind the handle"
      />
      <span className="windHint">drag right →</span>
    </div>
  );
}
