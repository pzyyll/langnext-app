-- Optional preferred source/target language ids for translation profiles (UI apply).
ALTER TABLE translation_profiles ADD COLUMN source_lang TEXT;
ALTER TABLE translation_profiles ADD COLUMN target_lang TEXT;
