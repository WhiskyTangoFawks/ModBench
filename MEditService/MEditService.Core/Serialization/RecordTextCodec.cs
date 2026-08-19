using System.Collections.Concurrent;
using System.IO.Abstractions;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization;
using Mutagen.Bethesda.Serialization.Newtonsoft;
using Mutagen.Bethesda.Serialization.Streams;
using Noggog;
using Noggog.IO;

namespace MEditService.Core.Serialization;

/// <summary>
/// Serializes a single record to per-record text and back — ADR-0041's per-record codec.
/// Always exactly one record to one caller-given file — there is no whole-plugin entry point, by
/// construction: this class is the only place in the assembly that calls the generated per-record
/// <c>&lt;Type&gt;_Serialization</c> methods, and every one of its own parameters is a single
/// record-getter type, never a plugin/mod type. See <see cref="RecordTextCodecGeneratorSeed"/> for
/// why the generator can produce those methods at all without this class ever touching a whole-mod
/// API itself.
///
/// #370: generalized from #367's Weapon-only proof of mechanism to any of the ~586 record types the
/// generator seeded (<see cref="RecordTextCodecGeneratorSeed"/>'s doc comment called this out as its
/// own follow-up design problem). Dispatch is by <b>reflection over the generated class name</b>,
/// not a hand-maintained switch: the generated <c>&lt;ConcreteTypeName&gt;_Serialization</c> class
/// lives in this assembly (Mutagen.Bethesda.Fallout4 namespace, <c>internal</c> — reachable via
/// reflection from inside this assembly, same as the direct call #367 used to make) for every
/// generated type, keyed purely by <c>record.GetType().Name</c>. A type with no such class throws
/// <see cref="RecordTypeSerializationUnsupportedException"/> — named and actionable, never a bare
/// <see cref="NullReferenceException"/> — rather than failing silently.
///
/// Deliberately takes/returns <see cref="IMajorRecordGetter"/>/<see cref="IMajorRecord"/>, not the
/// generated method's own narrower <c>I&lt;Type&gt;Getter</c> parameter type: reflection Invoke only
/// needs runtime assignability, so the caller-facing surface stays uniform across every record type
/// rather than growing a generic type parameter callers would have to supply by hand.
/// </summary>
public sealed class RecordTextCodec(ILogger<RecordTextCodec> logger)
{
    private static readonly MutagenSerializationWriterKernel<NewtonsoftJsonSerializationWriterKernel, JsonWritingUnit> WriterKernel = new();
    private static readonly NewtonsoftJsonSerializationReaderKernel ReaderKernel = new();

    // Closed generic MethodInfos, cached per record type (Serialize) / per (record type, reader
    // type) pair (Deserialize) — resolved once, reused for every record of that type. TWriter/
    // TReaderKernel never vary (always the Json kernel pair above), so the cache key never needs to
    // carry them.
    private static readonly ConcurrentDictionary<Type, MethodInfo> SerializeMethods = new();
    private static readonly ConcurrentDictionary<(Type Record, Type Reader), MethodInfo> DeserializeMethods = new();

    /// <summary>
    /// The record's ledger text as bytes, without touching the filesystem — the same bytes
    /// <see cref="SerializeAsync"/> writes, which is what lets the index store a document that is
    /// byte-identical to the ledger file (ADR-0041) and lets a byte compare stand in for
    /// dirty/ITM detection. Indexing a load order produces one of these per record, millions of
    /// times, so a temp-file round trip per record is not an option.
    /// </summary>
    public async Task<byte[]> SerializeToBytesAsync(IMajorRecordGetter record, GameRelease gameRelease, CancellationToken cancel = default)
    {
        // No directory: nothing here writes a file, so there is no folder for the serializer to
        // resolve anything against. SerializeAsync passes its target's folder instead, and
        // RecordTextCodecInMemoryTests pins that the two produce identical bytes for a real record
        // — if that ever stops holding, the difference is a real one and shows up there.
        var bytes = await SerializeCoreAsync(record, gameRelease, directory: string.Empty, cancel).ConfigureAwait(false);
        logger.LogTrace("Serialized record {FormKey} to {ByteCount} bytes", record.FormKey, bytes.Length);
        return bytes;
    }

    public async Task SerializeAsync(IMajorRecordGetter record, string filePath, GameRelease gameRelease, CancellationToken cancel = default)
    {
        // No Directory.CreateDirectory here, deliberately: this codec's file-writing caller decides
        // directory-creation policy with its own test (#370's original note; still true).
        var directory = Path.GetDirectoryName(filePath);
        var bytes = await SerializeCoreAsync(record, gameRelease, directory ?? string.Empty, cancel).ConfigureAwait(false);

        // Write-then-rename, not a direct write to filePath: File.Create truncates its target
        // immediately, before any new byte lands, so a direct write leaves a previously-valid
        // ledger record 0-byte or partial if cancellation or an IO failure lands in the window
        // between that truncation and the write completing — exactly the state #413's byte-compare
        // dirty/ITM detection, #414's commits, and #417's rebases would then all read as a
        // legitimate content change rather than damage (CLAUDE.md's never-assume-exclusive-
        // ownership rule, with Modbench itself as the corrupting writer here). tempPath sits beside
        // filePath (same volume), so File.Move is an atomic rename, not a copy — the destination
        // is either the old bytes or the new ones, in full, never anything in between. On failure,
        // the temp file is cleaned up and the original — untouched by any of this — survives.
        var tempPath = filePath + ".tmp";
        try
        {
            await using (var output = File.Create(tempPath))
                await output.WriteAsync(bytes, cancel).ConfigureAwait(false);

            File.Move(tempPath, filePath, overwrite: true);
        }
        catch
        {
            File.Delete(tempPath);
            throw;
        }

        logger.LogTrace("Serialized record {FormKey} to {FilePath}", record.FormKey, filePath);
    }

    /// <summary>
    /// The one serialization path — both public entry points are this method plus a destination.
    ///
    /// Buffered in memory rather than streamed, deliberately: AC4's identical-state-identical-bytes
    /// promise is cross-platform (#414 pins the other half of this same invariant,
    /// core.autocrlf=false at repo init), but Newtonsoft's JsonTextWriter has no public NewLine of
    /// its own to pin — confirmed by reflection (JsonTextWriter declares no NewLine property at
    /// all) and by decompiling WriteIndent(), which reads `_writer.NewLine` off its own *private*,
    /// unreachable inner TextWriter. JsonWritingUnit builds that inner writer itself with no
    /// injection point, so there is no supported way to reach in and pin it before the first indent
    /// is written. Buffering and normalizing after the fact is therefore this codec's own
    /// responsibility, not a kernel configuration knob — same shape as the trailing newline below,
    /// which the kernel also doesn't provide.
    /// </summary>
    private static async Task<byte[]> SerializeCoreAsync(
        IMajorRecordGetter record, GameRelease gameRelease, string directory, CancellationToken cancel)
    {
        using var buffer = new MemoryStream();
        var streamPackage = new StreamPackage(buffer, directory);
        var writer = WriterKernel.GetNewObject(streamPackage);
        var metaData = new SerializationMetaData(
            gameRelease, null, NoRecordFolders.Instance, DiscardChildRecordStreams.Instance, cancel);

        var serialize = ResolveSerializeMethod(record.GetType());
        var task = (Task)serialize.Invoke(null, [writer, record, WriterKernel, metaData])!;
        await task.ConfigureAwait(false);
        WriterKernel.Finalize(streamPackage, writer);

        // Two canonical-formatting guarantees the kernel itself doesn't make (AC4): no \r anywhere
        // (normalizes whatever the platform's Environment.NewLine produced for the kernel's own
        // indentation to bare \n — see the buffering note above) and exactly one trailing \n (the
        // kernel's own Finalize writes the closing brace and nothing after it).
        return [.. buffer.ToArray().Where(b => b != (byte)'\r'), (byte)'\n'];
    }

    /// <summary>Reads a record back from its JSON text on disk.</summary>
    /// <param name="filePath">Path to read the record's JSON text from.</param>
    /// <param name="recordType">The concrete record type to construct (e.g. <c>typeof(Npc)</c>) —
    /// the text itself carries no self-describing type tag, so the caller (which already knows the
    /// type from its own ledger path/schema) states it.</param>
    /// <param name="gameRelease">Game release the text was serialized under.</param>
    /// <param name="cancel">Cancellation token.</param>
    public async Task<IMajorRecord> DeserializeAsync(string filePath, Type recordType, GameRelease gameRelease, CancellationToken cancel = default)
    {
        using var stream = File.OpenRead(filePath);
        var record = await DeserializeCoreAsync(
            stream, Path.GetDirectoryName(filePath) ?? string.Empty, recordType, gameRelease, cancel).ConfigureAwait(false);

        logger.LogTrace("Deserialized record {FormKey} from {FilePath}", record.FormKey, filePath);
        return record;
    }

    /// <summary>
    /// Reads a record back from ledger text already in hand — the inverse of
    /// <see cref="SerializeToBytesAsync"/>. This is how a typed read reconstitutes a record from
    /// its stored document: the index holds the bytes, never a parsed object graph, and the
    /// reflected <c>ColumnSpec</c> extractors run against the record this returns, so a field's
    /// value is produced by exactly the same delegate whether it came from a plugin binary or from
    /// its own ledger text.
    /// </summary>
    /// <param name="bytes">The record's JSON text.</param>
    /// <param name="recordType">The concrete record type to construct (e.g. <c>typeof(Npc)</c>) —
    /// the text itself carries no self-describing type tag, so the caller (which already knows the
    /// type from its own ledger path/schema) states it.</param>
    /// <param name="gameRelease">Game release the text was serialized under.</param>
    /// <param name="cancel">Cancellation token.</param>
    public async Task<IMajorRecord> DeserializeFromBytesAsync(byte[] bytes, Type recordType, GameRelease gameRelease, CancellationToken cancel = default)
    {
        using var stream = new MemoryStream(bytes, writable: false);
        var record = await DeserializeCoreAsync(stream, string.Empty, recordType, gameRelease, cancel).ConfigureAwait(false);

        logger.LogTrace("Deserialized record {FormKey} from {ByteCount} bytes", record.FormKey, bytes.Length);
        return record;
    }

    private static async Task<IMajorRecord> DeserializeCoreAsync(
        Stream stream, string directory, Type recordType, GameRelease gameRelease, CancellationToken cancel)
    {
        var streamPackage = new StreamPackage(stream, directory);
        var reader = ReaderKernel.GetNewObject(streamPackage);
        var metaData = new SerializationMetaData(gameRelease, null, null, null, cancel);

        var deserialize = ResolveDeserializeMethod(recordType, reader.GetType());
        var task = (Task)deserialize.Invoke(null, [reader, ReaderKernel, metaData])!;
        await task.ConfigureAwait(false);
        return (IMajorRecord)task.GetType().GetProperty(nameof(Task<object>.Result))!.GetValue(task)!;
    }

    private static MethodInfo ResolveSerializeMethod(Type recordType) =>
        SerializeMethods.GetOrAdd(recordType, static t =>
        {
            var generated = FindGeneratedSerializationType(t);
            var open = generated.GetMethod("Serialize", BindingFlags.Public | BindingFlags.Static)
                ?? throw new RecordTypeSerializationUnsupportedException(t, generated, "Serialize");
            return open.MakeGenericMethod(typeof(NewtonsoftJsonSerializationWriterKernel), typeof(JsonWritingUnit));
        });

    private static MethodInfo ResolveDeserializeMethod(Type recordType, Type readerType) =>
        DeserializeMethods.GetOrAdd((recordType, readerType), static key =>
        {
            var generated = FindGeneratedSerializationType(key.Record);
            var open = generated.GetMethod("Deserialize", BindingFlags.Public | BindingFlags.Static)
                ?? throw new RecordTypeSerializationUnsupportedException(key.Record, generated, "Deserialize");
            return open.MakeGenericMethod(key.Reader);
        });

    // The generated classes live in *this* assembly (seeded by RecordTextCodecGeneratorSeed) under
    // the Mutagen.Bethesda.Fallout4 namespace, not the Mutagen.Bethesda.Fallout4.dll assembly the
    // record types themselves come from — so the lookup is against typeof(RecordTextCodec).Assembly,
    // deliberately not recordType.Assembly.
    //
    // Reader-agnostic by construction, not just by signature (#367 condition 2, re-broken and
    // re-fixed during #370's generalization): the generator names its class after the concrete
    // *setter* type only (e.g. "Weapon"), never a lazy overlay reader's own runtime type
    // ("WeaponBinaryOverlay") — confirmed by RecordTextCodecRealDataTests going red the moment
    // dispatch became type-name-only.
    //
    // A first attempt walked recordType's own implemented major-record getter interfaces
    // (I&lt;Type&gt;Getter) instead, on the theory that every reader shape for one record kind
    // implements the same one. That is true, but not *only* true of the right interface: a
    // concrete record type implements several unrelated I*Getter siblings (IBindableEquipmentGetter,
    // IEnchantableGetter, ...) plus ancestor interfaces shared across an entire game's schema
    // (IFallout4MajorRecordGetter) — and the generator has *also* emitted a (narrower, wrong)
    // serializer for at least one of those ancestors, so an unordered interface scan silently
    // picked it and produced truncated text instead of failing loud. Caught by
    // RecordTextCodecRealDataTests' text-equality assertion, not the dispatch test — a reminder
    // that "resolves to *a* type" and "resolves to the *right* type" are different claims.
    //
    // The fix relies on a narrower, Mutagen-stable fact instead of an open-ended interface search:
    // every overlay reader's runtime type is named "&lt;ConcreteSetterName&gt;BinaryOverlay" (the
    // convention `Fallout4Mod.CreateFromBinaryOverlay`'s output classes follow). Stripping that one
    // known suffix and retrying the direct lookup resolves overlay readers unambiguously, with no
    // risk of matching an unrelated sibling or ancestor interface.
    private static Type FindGeneratedSerializationType(Type recordType) =>
        TryFindGeneratedSerializationType(recordType, out var found)
            ? found
            : throw new RecordTypeSerializationUnsupportedException(recordType, null, null);

    private const string OverlaySuffix = "BinaryOverlay";

    /// <summary>
    /// Sends every <i>child</i> record's bytes nowhere. Under <c>.FilePerRecord()</c> a container
    /// (Cell/Worldspace/Quest/DialogTopic) writes each child major record to its own file through
    /// <c>SerializationMetaData.StreamCreator</c>, which defaults to one that creates real files
    /// and directories — measured: serializing a populated Cell with no destination folder created
    /// <c>Persistent/</c> and <c>Temporary/</c> directories in the process's working directory.
    ///
    /// Discarding them is the correct outcome, not a workaround: a child record is its own ledger
    /// entry and its own indexed row (ADR-0041/#387 — the parent's file carries only the parent's
    /// fields, which is exactly what the parent's own stream already receives), so anything written
    /// here would be a duplicate of a record handled in its own right.
    ///
    /// <b>This does NOT make the parent shallow.</b> An earlier revision of this comment claimed it
    /// did — that a getter straight off a binary overlay needed no mutable copy to strip — and the
    /// claim is measurably false. Serializing every container in the committed cut-down plugin both
    /// ways (overlay getter, vs. deep-parsed setter + <c>ContainerStripFields.StripInPlace</c>)
    /// found three populated exterior Cells whose overlay bytes still inline their children:
    /// <c>00DB41:Fallout4.esm</c> at 58,419 B against 12,959 B stripped, <c>00DB42</c> at
    /// 59,070/16,912, <c>00DB43</c> at 63,281/15,889. Suppressing the child <i>streams and
    /// folders</i> stops the filesystem writes; it does not stop the parent's own stream from
    /// carrying the children. Ingest therefore still deep-copies and strips a container before
    /// serializing it (#413 D8); this class is responsible only for the disk side.
    /// </summary>
    private sealed class DiscardChildRecordStreams : ICreateStream
    {
        internal static readonly DiscardChildRecordStreams Instance = new();

        public Stream GetStreamFor(IFileSystem fileSystem, FilePath path, bool write) => Stream.Null;
    }

    /// <summary>
    /// The other half of the same suppression: a container's child folders are created directly
    /// through <c>SerializationMetaData.FileSystem.Directory.CreateDirectory</c> (see Mutagen
    /// Serialization's MajorRecordListParallelHelper / BlockParallelHelper / XYBlockParallelHelper),
    /// not through the stream creator above, so redirecting streams alone does not stop them.
    /// Measured before this existed: serializing one real Quest created 1,057 directories — one per
    /// dialogue topic — in the process's working directory, and a load-order-wide index would do
    /// that for every container record it reads.
    ///
    /// Only <see cref="IDirectory.CreateDirectory(string)"/> is neutralized, and only to the extent
    /// of not touching the disk: it still returns a real <see cref="IDirectoryInfo"/> for the path
    /// (which the callers ignore), and every other filesystem operation behaves normally, so this
    /// cannot quietly disable a legitimate write elsewhere in the codec — the only writes this
    /// class's own file path makes are the temp+rename in <see cref="SerializeAsync"/>, which go
    /// through <see cref="File"/> directly and never through this.
    /// </summary>
    private sealed class NoRecordFolders : FileSystem
    {
        internal static readonly NoRecordFolders Instance = new();

        private readonly Lazy<IDirectory> _directory;

        private NoRecordFolders() => _directory = new Lazy<IDirectory>(() => new NonCreatingDirectory(this));

        public override IDirectory Directory => _directory.Value;

        private sealed class NonCreatingDirectory(IFileSystem fileSystem) : DirectoryWrapper(fileSystem)
        {
            public override IDirectoryInfo CreateDirectory(string path) => FileSystem.DirectoryInfo.New(path);
        }
    }

    private static bool TryFindGeneratedSerializationType(Type recordType, out Type found)
    {
        if (LookupGeneratedType(recordType, recordType.Name) is { } direct)
        {
            found = direct;
            return true;
        }

        if (recordType.Name.EndsWith(OverlaySuffix, StringComparison.Ordinal)
            && LookupGeneratedType(recordType, recordType.Name[..^OverlaySuffix.Length]) is { } viaOverlayName)
        {
            found = viaOverlayName;
            return true;
        }

        found = null!;
        return false;
    }

    // The generated class shares the record type's own namespace (Mutagen.Bethesda.<Game>), and
    // lives in *this* assembly rather than the game assembly (see FindGeneratedSerializationType).
    // Taking the namespace from the record rather than naming a game is what keeps this mechanism
    // game-generic (root CLAUDE.md): #413 makes this codec the ingest path for every record, so a
    // hardcoded game here would mean a Skyrim or Starfield session indexing nothing at all. What
    // stays per-game is only which types the generator was seeded for — see
    // RecordTextCodecGeneratorSeed, which is one file and deliberately concrete.
    private static Type? LookupGeneratedType(Type recordType, string concreteTypeName) =>
        typeof(RecordTextCodec).Assembly.GetType($"{recordType.Namespace}.{concreteTypeName}_Serialization");
}

/// <summary>
/// Thrown by <see cref="RecordTextCodec"/> when a record's runtime type has no generated
/// <c>&lt;Type&gt;_Serialization</c> class to dispatch to (missing entirely), or the generated class
/// exists but lacks the expected static method (a generator shape change) — named and actionable
/// rather than surfacing as a <see cref="NullReferenceException"/> from a failed reflection lookup.
/// </summary>
public sealed class RecordTypeSerializationUnsupportedException : Exception
{
    // RCS1194: the three standard exception constructors, for well-behaved rethrow/serialization
    // callers generally — not how RecordTextCodec itself throws this (see the Type-based
    // constructor below), which builds a specific, actionable message from the failed lookup.
    public RecordTypeSerializationUnsupportedException()
    {
    }

    public RecordTypeSerializationUnsupportedException(string message) : base(message)
    {
    }

    public RecordTypeSerializationUnsupportedException(string message, Exception innerException) : base(message, innerException)
    {
    }

    internal RecordTypeSerializationUnsupportedException(Type recordType, Type? generatedType, string? missingMethodName)
        : base(BuildMessage(recordType, generatedType, missingMethodName))
    {
    }

    // The expected name is derived from the record type's own namespace, not a named game — the
    // same derivation RecordTextCodec.LookupGeneratedType makes (#413 D5). Hardcoding "Fallout4"
    // here would have a Skyrim or Starfield record report a path the lookup never tried, which is
    // worse than no message at all: the reader would go looking for the wrong missing type.
    private static string BuildMessage(Type recordType, Type? generatedType, string? missingMethodName) =>
        generatedType == null
            ? $"No generated serializer found for record type '{recordType.Name}' — expected " +
              $"'{recordType.Namespace}.{recordType.Name}_Serialization' in this assembly. " +
              "RecordTextCodecGeneratorSeed seeds generation per game, and is seeded for the whole " +
              "FO4 record schema today; if a real record type lands here, the seed shape (or this " +
              "naming convention) needs revisiting."
            : $"Generated type '{generatedType.FullName}' has no public static '{missingMethodName}' " +
              "method — the generator's output shape may have changed.";
}
