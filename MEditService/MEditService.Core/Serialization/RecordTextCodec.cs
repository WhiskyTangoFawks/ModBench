using System.Collections.Concurrent;
using System.IO.Abstractions;
using System.Reflection;
using System.Text;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization;
using Mutagen.Bethesda.Serialization.Newtonsoft;
using Mutagen.Bethesda.Serialization.Streams;
using Noggog;
using Noggog.IO;

namespace MEditService.Core.Serialization;

/// <summary>ADR-0041's per-record codec: one record to one file, never a whole plugin. Takes
/// IMajorRecordGetter rather than the generated serializer's narrower interface, because
/// reflection needs only runtime assignability.</summary>
public sealed class RecordTextCodec(ILogger<RecordTextCodec> logger)
{
    private static readonly MutagenSerializationWriterKernel<NewtonsoftJsonSerializationWriterKernel, JsonWritingUnit> WriterKernel = new();
    private static readonly NewtonsoftJsonSerializationReaderKernel ReaderKernel = new();

    // Closed generic MethodInfos, resolved once per record type. TWriter/TReaderKernel never vary,
    // so the cache key never carries them.
    private static readonly ConcurrentDictionary<Type, MethodInfo> SerializeMethods = new();
    private static readonly ConcurrentDictionary<(Type Record, Type Reader), MethodInfo> DeserializeMethods = new();

    /// <summary>A document read and written back: the one shape gate a write goes through, and the
    /// spelling the codec gives what it kept.</summary>
    public string RoundTrip(string text, GameRelease gameRelease, string? recordType) =>
        SerializeToText(Deserialize(text, gameRelease, recordType), gameRelease);

    /// <summary>A document's own graph, read back by the type its text names — a path-ambiguous
    /// group's document names its own class, which is the codec's spelling, not the schema's
    /// table.</summary>
    internal IMajorRecord Deserialize(string text, GameRelease gameRelease, string? recordType) =>
        DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(text), gameRelease, recordType).GetAwaiter().GetResult();

    /// <summary>The record as the text a source document carries: what
    /// <see cref="SerializeToBytesAsync"/> produces, decoded.</summary>
    internal string SerializeToText(IMajorRecordGetter record, GameRelease gameRelease) =>
        Encoding.UTF8.GetString(SerializeToBytesAsync(record, gameRelease).GetAwaiter().GetResult());

    /// <summary>Two serializations, one for the caller and one for disk; this codec producing
    /// identical bytes for both is what makes what the index is told and what lands the same
    /// text.</summary>
    internal string SerializeAndWrite(IMajorRecordGetter record, string path, GameRelease gameRelease)
    {
        var text = SerializeToText(record, gameRelease);
        SerializeAsync(record, path, gameRelease).GetAwaiter().GetResult();
        return text;
    }

    /// <summary>The same bytes <see cref="SerializeAsync"/> writes, without the filesystem: the
    /// index stores a document byte-identical to the source file (ADR-0041), and indexing produces
    /// millions, so a temp-file round trip is not an option.</summary>
    public async Task<byte[]> SerializeToBytesAsync(IMajorRecordGetter record, GameRelease gameRelease, CancellationToken cancel = default)
    {
        // No directory: nothing here writes a file, so there is nothing to resolve against.
        var bytes = await SerializeCoreAsync(record, gameRelease, directory: string.Empty, cancel).ConfigureAwait(false);
        if (logger.IsEnabled(LogLevel.Trace))
        {
            logger.LogTrace("Serialized record {FormKey} to {ByteCount} bytes", record.FormKey, bytes.Length);
        }
        return bytes;
    }

    public async Task SerializeAsync(IMajorRecordGetter record, string filePath, GameRelease gameRelease, CancellationToken cancel = default)
    {
        // No Directory.CreateDirectory here, deliberately: directory-creation policy is the caller's.
        var directory = Path.GetDirectoryName(filePath);
        var bytes = await SerializeCoreAsync(record, gameRelease, directory ?? string.Empty, cancel).ConfigureAwait(false);

        // Write-then-rename: File.Create truncates before any new byte lands, so an interrupted
        // direct write leaves a 0-byte or partial record that dirty detection reads as an edit.
        // Same volume, so File.Move is an atomic rename.
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

    // Buffered rather than streamed: Newtonsoft's JsonTextWriter has no public NewLine to pin (it
    // reads its private inner TextWriter's), so newline normalization has to happen after the fact.
    private static async Task<byte[]> SerializeCoreAsync(
        IMajorRecordGetter record, GameRelease gameRelease, string directory, CancellationToken cancel)
    {
        using var buffer = new MemoryStream();
        var streamPackage = new StreamPackage(buffer, directory);
        var writer = WriterKernel.GetNewObject(streamPackage);
        var metaData = new SerializationMetaData(
            gameRelease, null, NoRecordFolders.Instance, DiscardChildRecordStreams.Instance, cancel);

        // Resolved first on both branches so an unsupported type fails with this class's named exception.
        var generated = FindGeneratedSerializationType(record.GetType());
        // ADR-0041's discriminator policy: a path-ambiguous record dispatches through the game's
        // abstract serializer, whose SerializeWithCheck writes MutagenObjectType ahead of the
        // fields, and every other record carries none.
        var serialize = RecordTypeDispatch.For(gameRelease).IsPathAmbiguous(record.GetType())
            ? ResolveCheckedSerializeMethod(gameRelease)
            : ResolveConcreteSerializeMethod(generated);
        var task = (Task)serialize.Invoke(null, [writer, record, WriterKernel, metaData])!;
        await task.ConfigureAwait(false);
        WriterKernel.Finalize(streamPackage, writer);

        // No \r anywhere: the kernel's indentation uses the platform newline. No trailing newline:
        // Finalize writes the closing brace and nothing after, as does the source tree, so adding
        // one would diverge from the whole-mod door's document shape.
        return [.. buffer.ToArray().Where(b => b != (byte)'\r')];
    }

    /// <summary><paramref name="recordType"/> is the index's own record_type; null means the
    /// document names its own type, true only of the path-ambiguous types.</summary>
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

    /// <summary>The index holds bytes, never a parsed graph. A document names its own type only when
    /// its path could not, so the caller states the record_type it knows (either spelling); null
    /// means self-describing.</summary>
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

    /// <summary>The instance the codec builds for an empty document of a Loqui class: every member
    /// at its declared default. A major record's empty document is its FormKey alone, the identity
    /// the codec requires first.</summary>
    public static Task<object> DeserializeEmptyAsync(Type loquiType, GameRelease gameRelease) =>
        DeserializeTextAsync(loquiType, typeof(IMajorRecordGetter).IsAssignableFrom(loquiType) ? EmptyMajorRecord : "{}", gameRelease);

    /// <summary>The empty document of a major record: the identity the codec requires first.</summary>
    public const string EmptyMajorRecord = "{\"FormKey\":\"Null\"}";

    /// <summary>The instance the codec builds for <paramref name="json"/> read as a Loqui class,
    /// which is how a fact about the class is asked of the codec rather than of reflection.</summary>
    public static async Task<object> DeserializeTextAsync(Type loquiType, string json, GameRelease gameRelease)
    {
        using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json), writable: false);
        return await DeserializeObjectAsync(stream, string.Empty, gameRelease,
            readerType => ResolveConcreteDeserializeMethod(loquiType, readerType), CancellationToken.None).ConfigureAwait(false);
    }

    private static async Task<IMajorRecord> DeserializeCoreAsync(
        Stream stream, string directory, GameRelease gameRelease, string? recordType, CancellationToken cancel)
    {
        // The reverse of SerializeCoreAsync's dispatch, driven by the same RecordTypeDispatch fact so
        // the two directions cannot disagree. An unknown recordType reads as ambiguous, so it takes
        // the self-describing path and fails loudly rather than constructing a guessed type.
        var dispatch = RecordTypeDispatch.For(gameRelease);
        var record = await DeserializeObjectAsync(stream, directory, gameRelease,
            readerType => recordType is null || dispatch.IsPathAmbiguous(recordType)
                ? ResolveCheckedDeserializeMethod(gameRelease, readerType)
                : ResolveConcreteDeserializeMethod(dispatch.ConcreteFor(recordType)!, readerType),
            cancel).ConfigureAwait(false);
        return (IMajorRecord)record;
    }

    private static async Task<object> DeserializeObjectAsync(
        Stream stream, string directory, GameRelease gameRelease, Func<Type, MethodInfo> resolve, CancellationToken cancel)
    {
        var streamPackage = new StreamPackage(stream, directory);
        var reader = ReaderKernel.GetNewObject(streamPackage);
        var metaData = new SerializationMetaData(gameRelease, null, null, null, cancel);

        var deserialize = resolve(reader.GetType());
        var task = (Task)deserialize.Invoke(null, [reader, ReaderKernel, metaData])!;
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is NotImplementedException or NullReferenceException)
        {
            // Two upstream routes to one failure: NotImplementedException is the generated dispatch's
            // "Unknown object name"; NullReferenceException is the kernel's GetNextType returning null
            // for a name that resolves to no Type. Deliberately narrow so nothing else is relabelled.
            throw new RecordTypeSerializationUnsupportedException(
                $"No record type in this game's schema matches the document's MutagenObjectType. {ex.Message}", ex);
        }

        return task.GetType().GetProperty(nameof(Task<object>.Result))!.GetValue(task)!;
    }

    // SerializeWithCheck writes MutagenObjectType ahead of the fields and DeserializeWithCheck
    // dispatches on it — the kernel's own mechanism for abstract group elements, adopted wholesale.
    // Without it a GLOB's text cannot say whether it is a GlobalFloat or a GlobalBool.
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

    // The unambiguous majority: the record's own generated <Type>_Serialization, no discriminator.
    // Shares the two caches above; the key spaces cannot collide, because a generated
    // *_Serialization class is never itself a record type.
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

    // The generated classes live in this assembly under the game's namespace, so the lookup is
    // against typeof(RecordTextCodec).Assembly, never recordType.Assembly.
    private static Type FindGeneratedSerializationType(Type recordType) =>
        TryFindGeneratedSerializationType(recordType, out var found)
            ? found
            : throw new RecordTypeSerializationUnsupportedException(recordType, null, null);

    private const string OverlaySuffix = "BinaryOverlay";

    // Under FilePerRecord a container writes each non-embedded child (a worldspace's blocks) to its
    // own file via StreamCreator. A block level is its own source unit, so its bytes go nowhere.
    private sealed class DiscardChildRecordStreams : ICreateStream
    {
        internal static readonly DiscardChildRecordStreams Instance = new();

        public Stream GetStreamFor(IFileSystem fileSystem, FilePath path, bool write) => Stream.Null;
    }

    // Child folders are created directly through FileSystem.Directory.CreateDirectory, not the
    // stream creator, so that alone does not stop them. Only CreateDirectory is neutralized; the
    // codec's own temp+rename goes through File directly and never through this.
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

    // An overlay reader's runtime type is "<ConcreteSetterName>BinaryOverlay"; stripping that one
    // suffix is the only safe normalization: an interface scan matched an ancestor's narrower
    // serializer and silently produced truncated text.
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

    // The namespace comes from the record rather than a named game so this ingest path stays
    // game-generic; only the seed (RecordTextCodecGeneratorSeed) is per-game.
    private static Type? LookupGeneratedType(Type recordType, string concreteTypeName) =>
        typeof(RecordTextCodec).Assembly.GetType($"{recordType.Namespace}.{concreteTypeName}_Serialization");
}

/// <summary>A record's runtime type has no generated &lt;Type&gt;_Serialization class, or the class
/// lacks the expected static method (a generator shape change) — named and actionable rather than
/// a bare NullReferenceException from a failed reflection lookup.</summary>
public sealed class RecordTypeSerializationUnsupportedException : Exception
{
    // RCS1194: the three standard exception constructors, for well-behaved rethrow and serialization.
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

    // Derived from the record type's namespace, not a named game, the same derivation
    // LookupGeneratedType makes; hardcoding "Fallout4" would have a Skyrim record report a path the
    // lookup never tried.
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
