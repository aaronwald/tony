import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface NewTaskPromptProps {
  existingIds: string[];
  onConfirm: (id: string, type: "agent" | "chat") => void;
  onCancel: () => void;
}

export function NewTaskPrompt({ existingIds, onConfirm, onCancel }: NewTaskPromptProps) {
  const [step, setStep] = useState<"id" | "type">("id");
  const [id, setId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const handleIdSubmit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === "") {
      setError("ID cannot be empty");
      return;
    }
    if (existingIds.includes(trimmed)) {
      setError(`Task "${trimmed}" already exists`);
      return;
    }
    setId(trimmed);
    setError(null);
    setStep("type");
  };

  if (step === "id") {
    return (
      <Box flexDirection="column">
        <Text bold>New Task</Text>
        <Box>
          <Text>Task ID: </Text>
          <TextInput value={id} onChange={setId} onSubmit={handleIdSubmit} />
        </Box>
        {error && <Text color="red">{error}</Text>}
        <Text dimColor>Escape to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>New Task: {id}</Text>
      <Text>Select type:</Text>
      <TypeSelector onSelect={(type) => onConfirm(id, type)} />
      <Text dimColor>Escape to cancel</Text>
    </Box>
  );
}

function TypeSelector({ onSelect }: { onSelect: (type: "agent" | "chat") => void }) {
  const [selected, setSelected] = useState(0);
  const options: Array<"agent" | "chat"> = ["agent", "chat"];

  useInput((_input, key) => {
    if (key.upArrow || key.downArrow) {
      setSelected((s) => (s === 0 ? 1 : 0));
    } else if (key.return) {
      onSelect(options[selected]);
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((opt, i) => (
        <Text key={opt} color={i === selected ? "cyan" : undefined} bold={i === selected}>
          {i === selected ? "> " : "  "}{opt}
        </Text>
      ))}
    </Box>
  );
}
