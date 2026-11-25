CREATE TABLE translation_history (
    sequence INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    source_text TEXT NOT NULL,
    preview TEXT NOT NULL
);

CREATE TABLE translation_history_result (
    history_sequence INTEGER NOT NULL REFERENCES translation_history(sequence) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    preset_name TEXT NOT NULL,
    source_language TEXT NOT NULL,
    target_language TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    PRIMARY KEY (history_sequence, position)
);
