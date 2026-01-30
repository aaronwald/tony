import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

export interface CommandInputProps {
  onSubmit: (command: string) => void;
  onCancel: () => void;
  loading: boolean;
  response: string | null;
  error: string | null;
  changedFields: string[];
}

export function CommandInput({
  onSubmit,
  onCancel,
  loading,
  response,
  error,
  changedFields,
}: CommandInputProps): React.ReactElement {
  const [value, setValue] = useState("");

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
      }
    },
    { isActive: !loading }
  );

  const handleSubmit = (text: string) => {
    if (text.trim()) {
      onSubmit(text.trim());
    }
  };

  return (
    <Box flexDirection="column">
      {response ? (
        <Box marginBottom={1}>
          <Text color="green">{response}</Text>
        </Box>
      ) : null}

      {error ? (
        <Box marginBottom={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      ) : null}

      {changedFields.length > 0 ? (
        <Box marginBottom={1}>
          <Text color="yellow">
            Changed: {changedFields.join(", ")}
          </Text>
        </Box>
      ) : null}

      <Box>
        <Text bold>:</Text>
        {loading ? (
          <Text dimColor> Processing...</Text>
        ) : (
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
          />
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Escape: cancel</Text>
      </Box>
    </Box>
  );
}
