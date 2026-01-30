import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface SubListProps {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  onBack: () => void;
  helpText?: string;
}

export function SubList({ label, items, onChange, onBack, helpText }: SubListProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState("");

  useInput((input, key) => {
    if (adding) return;

    if (key.escape) {
      onBack();
    } else if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (input === "a") {
      setAdding(true);
      setNewValue("");
    } else if (input === "d" && items.length > 0) {
      const next = [...items];
      next.splice(selectedIndex, 1);
      onChange(next);
      setSelectedIndex(Math.min(selectedIndex, next.length - 1));
    } else if (input === "j" && selectedIndex < items.length - 1) {
      const next = [...items];
      [next[selectedIndex], next[selectedIndex + 1]] = [next[selectedIndex + 1], next[selectedIndex]];
      onChange(next);
      setSelectedIndex(selectedIndex + 1);
    } else if (input === "k" && selectedIndex > 0) {
      const next = [...items];
      [next[selectedIndex], next[selectedIndex - 1]] = [next[selectedIndex - 1], next[selectedIndex]];
      onChange(next);
      setSelectedIndex(selectedIndex - 1);
    }
  });

  const handleAddSubmit = (value: string) => {
    if (value.trim()) {
      onChange([...items, value.trim()]);
    }
    setAdding(false);
  };

  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>

      {items.length === 0 && !adding && (
        <Text dimColor>Empty. Press a to add.</Text>
      )}

      {items.map((item, i) => {
        const selected = i === selectedIndex;
        return (
          <Box key={`${i}-${item}`}>
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {selected ? "> " : "  "}{item}
            </Text>
          </Box>
        );
      })}

      {adding && (
        <Box>
          <Text color="green">+ </Text>
          <TextInput
            value={newValue}
            onChange={setNewValue}
            onSubmit={handleAddSubmit}
          />
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          a add  d delete  j/k reorder  Escape back
          {helpText ? `  |  ${helpText}` : ""}
        </Text>
      </Box>
    </Box>
  );
}
