namespace MEditService.Codec.Serialization;

/// <summary>What the game's Creation Kit always writes, each fact proven over the game's vanilla
/// binaries, so a plugin departing from one was malformed by another tool (ADR-0006).</summary>
public sealed record CreationKitShapes(
    // (record type, subrecord) → the payload size always written; a shorter one is zero-padded, losslessly.
    IReadOnlyDictionary<(string RecordType, string Sig), int> SubrecordSizes,
    // (record type, subrecord) → the count written whenever any is; zero occurrences stays clean.
    IReadOnlyDictionary<(string RecordType, string Sig), int> SubrecordCounts,
    // (record type, counter) → the entry subrecord its u32 counts; entries follow contiguously.
    IReadOnlyDictionary<(string RecordType, string Counter), string> CountedEntries,
    // Record types whose template combinations are written OBTF, FULL, OBTS.
    IReadOnlySet<string> TemplateCombinations,
    PerkEntryPointShapes EntryPoints);

/// <summary>A perk entry point's parameter block, by its function. A function vanilla never
/// exercises is in none of these, so it is never diagnosed.</summary>
public sealed record PerkEntryPointShapes(
    IReadOnlyDictionary<byte, byte> EpftByFunction,
    IReadOnlySet<byte> FunctionsWithoutParameters,
    IReadOnlySet<byte> FunctionsCarryingEpf3);
