using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Serialization;
using Mutagen.Bethesda.Serialization.Streams;
using Mutagen.Bethesda.Serialization.Yaml;

namespace MEditService.Core.Serialization;

/// <summary>
/// Serializes a single record to per-record YAML text and back (ADR-0040 stage 1's ledger codec).
/// Always exactly one record to one caller-given file — there is no whole-plugin entry point, by
/// construction: this class is the only place in the assembly that calls the generated per-record
/// <c>&lt;Type&gt;_Serialization</c> methods, and every one of its own parameters is a single
/// record-getter type, never a plugin/mod type. See <see cref="RecordTextCodecGeneratorSeed"/> for
/// why the generator can produce those methods at all without this class ever touching a whole-mod
/// API itself.
///
/// #367 scope: proves the mechanism against one concrete record type (<see cref="Weapon"/>).
/// Generalizing to arbitrary record types chosen at runtime needs a dispatch design of its own
/// (see #367's report to the tracker for the two follow-up probes) and is out of scope here.
/// </summary>
public sealed class RecordTextCodec(ILogger<RecordTextCodec> logger)
{
    private static readonly MutagenSerializationWriterKernel<YamlSerializationWriterKernel, YamlWritingUnit> WriterKernel = new();
    private static readonly YamlSerializationReaderKernel ReaderKernel = new();

    public async Task SerializeAsync(IWeaponGetter record, string filePath, GameRelease gameRelease, CancellationToken cancel = default)
    {
        // No Directory.CreateDirectory here, deliberately: RecordTextCodec has no production
        // caller yet (that's #370, and the ACs say nothing about directory-creation policy) — this
        // is exactly the "machinery now, use it later" shape the root CLAUDE.md's Minimal-by-Default
        // rule rejects. #370's caller decides that policy with its own test.
        var directory = Path.GetDirectoryName(filePath);
        using var stream = File.Create(filePath);
        var streamPackage = new StreamPackage(stream, directory ?? string.Empty);
        var writer = WriterKernel.GetNewObject(streamPackage);
        var metaData = new SerializationMetaData(gameRelease, null, null, null, cancel);

        await Weapon_Serialization.Serialize<YamlSerializationWriterKernel, YamlWritingUnit>(
            writer, record, WriterKernel, metaData);
        WriterKernel.Finalize(streamPackage, writer);

        logger.LogTrace("Serialized record {FormKey} to {FilePath}", record.FormKey, filePath);
    }

    public async Task<Weapon> DeserializeAsync(string filePath, GameRelease gameRelease, CancellationToken cancel = default)
    {
        using var stream = File.OpenRead(filePath);
        var streamPackage = new StreamPackage(stream, Path.GetDirectoryName(filePath) ?? string.Empty);
        var reader = ReaderKernel.GetNewObject(streamPackage);
        var metaData = new SerializationMetaData(gameRelease, null, null, null, cancel);

        var record = await Weapon_Serialization.Deserialize(reader, ReaderKernel, metaData);

        logger.LogTrace("Deserialized record {FormKey} from {FilePath}", record.FormKey, filePath);
        return record;
    }
}
