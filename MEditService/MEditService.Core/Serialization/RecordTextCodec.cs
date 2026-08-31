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
/// Handles any of the ~586 record types the
/// generator seeded (<see cref="RecordTextCodecGeneratorSeed"/>). Dispatch is by <b>reflection over the generated class name</b>,
/// not a hand-maintained switch: the generated <c>&lt;ConcreteTypeName&gt;_Serialization</c> class
/// lives in this assembly (Mutagen.Bethesda.Fallout4 namespace, <c>internal</c> — reachable via
/// reflection from inside this assembly) for every
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
    /// The record's source text as bytes, without touching the filesystem — the same bytes
    /// <see cref="SerializeAsync"/> writes, which is what lets the index store a document that is
    /// byte-identical to the source file (ADR-0041) and lets a byte compare stand in for
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
        if (logger.IsEnabled(LogLevel.Trace))
        {
            logger.LogTrace("Serialized record {FormKey} to {ByteCount} bytes", record.FormKey, bytes.Length);
        }
        return bytes;
    }

    public async Task SerializeAsync(IMajorRecordGetter record, string filePath, GameRelease gameRelease, CancellationToken cancel = default)
    {
        // No Directory.CreateDirectory here, deliberately: this codec's file-writing caller decides
        // directory-creation policy with its own test.
        var directory = Path.GetDirectoryName(filePath);
        var bytes = await SerializeCoreAsync(record, gameRelease, directory ?? string.Empty, cancel).ConfigureAwait(false);

        // Write-then-rename, not a direct write to filePath: File.Create truncates its target
        // immediately, before any new byte lands, so a direct write leaves a previously-valid
        // source record 0-byte or partial if cancellation or an IO failure lands in the window
        // between that truncation and the write completing — exactly the state byte-compare
        // dirty/ITM detection, commits, and rebases would then all read as a
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

        if (logger.IsEnabled(LogLevel.Trace))
        {
            logger.LogTrace("Serialized record {FormKey} to {FilePath}", record.FormKey, filePath);
        }
    }

    /// <summary>
    /// The one serialization path — both public entry points are this method plus a destination.
    ///
    /// Buffered in memory rather than streamed, deliberately: the identical-state-identical-bytes
    /// promise is cross-platform (the other half of this same invariant is
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

        // The whole-mod door's own discriminator policy (ADR-0041): a
        // path-ambiguous record dispatches through the game's *abstract* major-record serializer,
        // whose SerializeWithCheck writes the MutagenObjectType discriminator ahead of the fields.
        // Every other record dispatches its own concrete <Type>_Serialization.Serialize and carries
        // none — see RecordTypeDispatch for where "ambiguous" is read from, and
        // ResolveCheckedSerializeMethod for what the checked path emits. The concrete generated type
        // is resolved first on both branches, so an unsupported record type keeps failing with this
        // class's named exception rather than the generated code's bare NotImplementedException.
        var generated = FindGeneratedSerializationType(record.GetType());
        var serialize = RecordTypeDispatch.For(gameRelease).IsPathAmbiguous(record.GetType())
            ? ResolveCheckedSerializeMethod(gameRelease)
            : ResolveConcreteSerializeMethod(generated);
        var task = (Task)serialize.Invoke(null, [writer, record, WriterKernel, metaData])!;
        await task.ConfigureAwait(false);
        WriterKernel.Finalize(streamPackage, writer);

        // The one canonical-formatting guarantee the kernel itself doesn't make: no \r anywhere,
        // normalizing whatever the platform's Environment.NewLine produced for the kernel's own
        // indentation down to bare \n (see the buffering note above).
        //
        // Deliberately *no* trailing newline: the kernel's
        // Finalize writes the closing brace and nothing after it, and so does the source tree, so a
        // trailing \n here would be this codec's own divergence from the document shape it is
        // supposed to share with the whole-mod door. Canonical form is
        // bare \n newlines with nothing after the closing brace, on every platform, and
        // DocumentShapeParityTests holds both doors to it byte for byte.
        return [.. buffer.ToArray().Where(b => b != (byte)'\r')];
    }

    /// <summary>Reads a record back from its JSON text on disk.</summary>
    /// <param name="filePath">Path to read the record's JSON text from.</param>
    /// <param name="gameRelease">Game release the text was serialized under.</param>
    /// <param name="recordType">The index's own <c>record_type</c> for this record — see
    /// <see cref="DeserializeFromBytesAsync"/> for why it is needed and what it may hold. Null means
    /// "this document names its own type", which is true only of the path-ambiguous types.</param>
    /// <param name="cancel">Cancellation token.</param>
    public async Task<IMajorRecord> DeserializeAsync(
        string filePath, GameRelease gameRelease, string? recordType, CancellationToken cancel = default)
    {
        using var stream = File.OpenRead(filePath);
        var record = await DeserializeCoreAsync(
            stream, Path.GetDirectoryName(filePath) ?? string.Empty, gameRelease, recordType, cancel).ConfigureAwait(false);

        if (logger.IsEnabled(LogLevel.Trace))
        {
            logger.LogTrace("Deserialized record {FormKey} from {FilePath}", record.FormKey, filePath);
        }
        return record;
    }

    /// <summary>
    /// Reads a record back from source text already in hand — the inverse of
    /// <see cref="SerializeToBytesAsync"/>. This is how a typed read reconstitutes a record from
    /// its stored document: the index holds the bytes, never a parsed object graph, and the
    /// reflected <c>ColumnSpec</c> extractors run against the record this returns, so a field's
    /// value is produced by exactly the same delegate whether it came from a plugin binary or from
    /// its own source text.
    ///
    /// <para>A document only names its own type when its <i>path</i> could not — so the
    /// caller states the type it already knows, which at every call site is the index's
    /// <c>record_type</c> column (or, for compile, the record-type segment of the source path, which
    /// is the same string). Two spellings ride on that column and both are accepted:
    /// the schema table name (a GRUP signature, <c>"weap"</c>) and the lowercased CLR type name
    /// (<c>"landscape"</c>) — see <see cref="RecordTypeDispatch"/>. Null means "the document names
    /// its own type"; for an unambiguous type that is a failure, and it surfaces as
    /// <see cref="RecordTypeSerializationUnsupportedException"/> rather than a wrong record.</para>
    /// </summary>
    /// <param name="bytes">The record's JSON text.</param>
    /// <param name="gameRelease">Game release the text was serialized under.</param>
    /// <param name="recordType">The index's own <c>record_type</c> for this record, or null when the
    /// document is known to be self-describing.</param>
    /// <param name="cancel">Cancellation token.</param>
    public async Task<IMajorRecord> DeserializeFromBytesAsync(
        byte[] bytes, GameRelease gameRelease, string? recordType, CancellationToken cancel = default)
    {
        using var stream = new MemoryStream(bytes, writable: false);
        var record = await DeserializeCoreAsync(stream, string.Empty, gameRelease, recordType, cancel).ConfigureAwait(false);

        if (logger.IsEnabled(LogLevel.Trace))
        {
            logger.LogTrace("Deserialized record {FormKey} from {ByteCount} bytes", record.FormKey, bytes.Length);
        }
        return record;
    }

    private static async Task<IMajorRecord> DeserializeCoreAsync(
        Stream stream, string directory, GameRelease gameRelease, string? recordType, CancellationToken cancel)
    {
        var streamPackage = new StreamPackage(stream, directory);
        var reader = ReaderKernel.GetNewObject(streamPackage);
        var metaData = new SerializationMetaData(gameRelease, null, null, null, cancel);

        // The mirror of SerializeCoreAsync's dispatch, driven by the same RecordTypeDispatch fact, so
        // the two directions cannot disagree about which documents self-describe: a discriminated
        // document is read by the game's DeserializeWithCheck, an undiscriminated one by its own
        // concrete <Type>_Serialization.Deserialize. A recordType this game's schema does not know
        // reads as ambiguous, so it takes the self-describing path and fails loudly there rather than
        // constructing whatever type happened to be guessed.
        var dispatch = RecordTypeDispatch.For(gameRelease);
        var deserialize = recordType is null || dispatch.IsPathAmbiguous(recordType)
            ? ResolveCheckedDeserializeMethod(gameRelease, reader.GetType())
            : ResolveConcreteDeserializeMethod(dispatch.ConcreteFor(recordType)!, reader.GetType());
        var task = (Task)deserialize.Invoke(null, [reader, ReaderKernel, metaData])!;
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is NotImplementedException or NullReferenceException)
        {
            // Text whose MutagenObjectType this game's dispatch cannot resolve — corrupt text, a
            // hand-edited source file, or text from a future schema. Both exception types are the
            // same failure arriving by two upstream routes, and neither is actionable as-is:
            //
            //   NotImplementedException — the generated dispatch's own "Unknown object name X",
            //     raised when the name resolves to a Type it has no case for.
            //   NullReferenceException — the name does not resolve to a Type at all. The kernel's
            //     GetNextType returns null there, and the generated code calls GetSimpleName() on it
            //     without a guard, so it faults before reaching its own default branch. That is an
            //     upstream defect; catching it here converts it into the same named, actionable
            //     failure rather than letting a bare NRE escape to a caller, which is the exact
            //     outcome this class has always existed to prevent.
            //
            // Deliberately narrow: only these two types, only around the dispatch call itself, so
            // nothing else that might throw inside deserialization is silently relabelled.
            throw new RecordTypeSerializationUnsupportedException(
                $"No record type in this game's schema matches the document's MutagenObjectType. {ex.Message}", ex);
        }

        return (IMajorRecord)task.GetType().GetProperty(nameof(Task<object>.Result))!.GetValue(task)!;
    }

    /// <summary>
    /// The game's <i>abstract</i> major-record serializer — <c>&lt;Game&gt;MajorRecord_Serialization</c>
    /// — used for the path-ambiguous types only (<see cref="RecordTypeDispatch"/>).
    ///
    /// <para>That one choice is what makes a document self-describing. The generated
    /// <c>SerializeWithCheck</c> writes <c>kernel.WriteType(writer, item.GetType())</c> — emitted by
    /// the JSON kernel as a leading <c>"MutagenObjectType"</c> field — and then dispatches to the
    /// concrete serializer; <c>DeserializeWithCheck</c> reads that field back and dispatches to the
    /// matching concrete deserializer. It is the same mechanism the kernel already uses whenever a
    /// group's element type is abstract, which is how Spriggit round-trips whole mods (a
    /// <c>Group&lt;GameSetting&gt;</c> serializes each item through
    /// <c>GameSetting_Serialization.SerializeWithCheck</c>), so this is the kernel's own answer
    /// adopted wholesale rather than a discriminator of our invention.</para>
    ///
    /// <para>Without it those types could not be read back at all: the text alone cannot say whether
    /// a GLOB is a GlobalFloat or a GlobalBool, and guessing wrong throws (measured: deserializing a
    /// real GlobalFloat's document as the schema's discovery-winner GlobalBool fails with "Unable to
    /// cast object of type 'System.Double' to type 'System.Boolean'"). The discriminator is written
    /// for exactly those types and no others, matching the whole-mod door — a Weapon's file there has
    /// no discriminator, and neither does this codec's — and the guarantee for GLOB is untouched,
    /// because the ambiguous types are precisely the ones that keep it.</para>
    ///
    /// <para>The kernel normalizes the runtime type for us: a <c>NpcBinaryOverlay</c> is written as
    /// <c>"Npc"</c>, so an overlay-read record and a deep-parsed one produce identical text.</para>
    ///
    /// <para>Keyed by game, and resolved from the game's own namespace rather than a named one, for
    /// the same reason the concrete lookup is.</para>
    /// </summary>
    private static MethodInfo ResolveCheckedSerializeMethod(GameRelease gameRelease) =>
        SerializeMethods.GetOrAdd(GameMajorRecordSerializationType(gameRelease), static t =>
        {
            var open = t.GetMethod("SerializeWithCheck", BindingFlags.Public | BindingFlags.Static)
                ?? throw new RecordTypeSerializationUnsupportedException(t, t, "SerializeWithCheck");
            return open.MakeGenericMethod(typeof(NewtonsoftJsonSerializationWriterKernel), typeof(JsonWritingUnit));
        });

    private static MethodInfo ResolveCheckedDeserializeMethod(GameRelease gameRelease, Type readerType) =>
        DeserializeMethods.GetOrAdd((GameMajorRecordSerializationType(gameRelease), readerType), static key =>
        {
            var open = key.Record.GetMethod("DeserializeWithCheck", BindingFlags.Public | BindingFlags.Static)
                ?? throw new RecordTypeSerializationUnsupportedException(key.Record, key.Record, "DeserializeWithCheck");
            return open.MakeGenericMethod(key.Reader);
        });

    // The unambiguous majority: the record's own generated <Type>_Serialization, which writes and
    // reads the fields with no discriminator around them — the same methods the whole-mod group
    // writer calls for a concrete-element group. Cached in the same two dictionaries as the checked
    // pair above; the key spaces cannot collide, because a generated *_Serialization class is never
    // itself a record type.
    private static MethodInfo ResolveConcreteSerializeMethod(Type generatedType) =>
        SerializeMethods.GetOrAdd(generatedType, static t =>
        {
            var open = t.GetMethod("Serialize", BindingFlags.Public | BindingFlags.Static)
                ?? throw new RecordTypeSerializationUnsupportedException(t, t, "Serialize");
            return open.MakeGenericMethod(typeof(NewtonsoftJsonSerializationWriterKernel), typeof(JsonWritingUnit));
        });

    private static MethodInfo ResolveConcreteDeserializeMethod(Type recordType, Type readerType) =>
        DeserializeMethods.GetOrAdd((FindGeneratedSerializationType(recordType), readerType), static key =>
        {
            var open = key.Record.GetMethod("Deserialize", BindingFlags.Public | BindingFlags.Static)
                ?? throw new RecordTypeSerializationUnsupportedException(key.Record, key.Record, "Deserialize");
            return open.MakeGenericMethod(key.Reader);
        });

    private static Type GameMajorRecordSerializationType(GameRelease gameRelease)
    {
        var category = gameRelease.ToCategory();
        var name = $"Mutagen.Bethesda.{category}.{category}MajorRecord_Serialization";
        return typeof(RecordTextCodec).Assembly.GetType(name)
            ?? throw new RecordTypeSerializationUnsupportedException(
                $"No '{name}' was generated into this assembly, so no record of {category} can be " +
                "serialized or read back. RecordTextCodecGeneratorSeed seeds generation per game; a " +
                "game reaching here needs its own seed entry.");
    }

    // The generated classes live in *this* assembly (seeded by RecordTextCodecGeneratorSeed) under
    // the Mutagen.Bethesda.Fallout4 namespace, not the Mutagen.Bethesda.Fallout4.dll assembly the
    // record types themselves come from — so the lookup is against typeof(RecordTextCodec).Assembly,
    // deliberately not recordType.Assembly.
    //
    // Reader-agnostic by construction, not just by signature: the generator names its class after
    // the concrete *setter* type only (e.g. "Weapon"), never a lazy overlay reader's own runtime
    // type ("WeaponBinaryOverlay") — pinned by RecordTextCodecRealDataTests.
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
    /// <summary>
    /// The record type's own generated <c>&lt;Type&gt;_Serialization</c> class. It is what the
    /// unambiguous majority dispatches straight through, and on the ambiguous branch it is still
    /// resolved first as a guard: a record type with no generated serializer would otherwise reach
    /// the game base's <c>switch</c> and fail with the generated code's bare "Unknown object"
    /// <see cref="NotImplementedException"/>, losing the named, actionable error this class has
    /// always raised for that case.
    /// </summary>
    private static Type FindGeneratedSerializationType(Type recordType) =>
        TryFindGeneratedSerializationType(recordType, out var found)
            ? found
            : throw new RecordTypeSerializationUnsupportedException(recordType, null, null);

    private const string OverlaySuffix = "BinaryOverlay";

    /// <summary>
    /// Sends every <i>folder-split</i> child record's bytes nowhere. Under <c>.FilePerRecord()</c> a
    /// container writes each child major record it does not embed to its own file through
    /// <c>SerializationMetaData.StreamCreator</c>, which defaults to one that creates real files and
    /// directories — and this codec's callers hand it no directory to spill into (ingest passes none
    /// at all, so the destination is the process's working directory).
    ///
    /// <para><b>Which children this applies to.</b> Spriggit embeds
    /// <c>Cell.{Persistent,Temporary,Landscape,NavigationMeshes}</c> and <c>Worldspace.TopCell</c>
    /// (<see cref="CellEmbedCustomization"/>), and an embedded child is written inline into
    /// the parent's own stream — it never reaches a stream creator, so this class never sees it.
    /// What is left is the containers Spriggit does <i>not</i> embed:
    /// <c>Quest.{DialogBranches,DialogTopics,Scenes}</c> and <c>DialogTopic.Responses</c>, which stay
    /// folder-split on both doors. Measured before this existed: one real Quest created 1,057
    /// directories, one per dialogue topic, and a load-order-wide index would do that for every
    /// container it read. So this is <b>not</b> shallow-strip machinery — "containers serialize
    /// embedded" holds only for the five slots above.</para>
    ///
    /// <para>Discarding is the correct outcome, not a workaround: a folder-split child is its own
    /// source unit and its own indexed row, so anything written here would duplicate a record handled
    /// in its own right — and it costs nothing at the byte level, because the parent's own stream is
    /// unaffected either way. <c>DocumentShapeParityTests</c> pins that directly, on a populated
    /// Quest: same bytes as the whole-mod door's file for it, with these suppressions active.</para>
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
    /// not through the stream creator above, so redirecting streams alone does not stop them. Same
    /// scope as <see cref="DiscardChildRecordStreams"/> — the embedded slots never reach
    /// either of these, so what both are guarding is Quest/DialogTopic, which is exactly the Quest
    /// measurement that motivated this one.
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
    // game-generic (root CLAUDE.md): this codec is the ingest path for every record, so a
    // hardcoded game here would mean a Skyrim or Starfield load order indexing nothing at all. What
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
    // same derivation RecordTextCodec.LookupGeneratedType makes. Hardcoding "Fallout4"
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
