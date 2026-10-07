using System.Collections.Concurrent;
using System.IO.Abstractions;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization;
using Mutagen.Bethesda.Serialization.Newtonsoft;
using Mutagen.Bethesda.Serialization.Streams;
using Noggog;
using Noggog.IO;

namespace MEditService.Codec.Serialization;

/// <summary>The per-record codec, never a whole plugin (ADR-0006). Takes
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
    internal IMajorRecord Deserialize(string text, GameRelease gameRelease, string? recordType)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        using var stream = new MemoryStream(bytes, writable: false);
        var record = DeserializeCore(stream, gameRelease, recordType, CancellationToken.None);

        if (logger.IsEnabled(LogLevel.Trace))
        {
            logger.LogTrace("Deserialized record {FormKey} from {ByteCount} bytes", record.FormKey, bytes.Length);
        }
        return record;
    }

    /// <summary>The record as the text a source document carries: what
    /// <see cref="SerializeToBytes"/> produces, decoded.</summary>
    public string SerializeToText(IMajorRecordGetter record, GameRelease gameRelease) =>
        Encoding.UTF8.GetString(SerializeToBytes(record, gameRelease));

    /// <summary>The bytes of a source document, without the filesystem (ADR-0005): indexing
    /// produces millions, so a temp-file round trip is not an option.</summary>
    public byte[] SerializeToBytes(IMajorRecordGetter record, GameRelease gameRelease, CancellationToken cancel = default)
    {
        var bytes = SerializeCore(record, gameRelease, cancel);
        if (logger.IsEnabled(LogLevel.Trace))
        {
            logger.LogTrace("Serialized record {FormKey} to {ByteCount} bytes", record.FormKey, bytes.Length);
        }
        return bytes;
    }

    // Buffered rather than streamed: Newtonsoft's JsonTextWriter has no public NewLine to pin (it
    // reads its private inner TextWriter's), so newline normalization has to happen after the fact.
    private static byte[] SerializeCore(
        object record, GameRelease gameRelease, CancellationToken cancel)
    {
        using var buffer = new MemoryStream();
        var streamPackage = new StreamPackage(buffer, string.Empty);
        var writer = WriterKernel.GetNewObject(streamPackage);
        var metaData = new SerializationMetaData(
            gameRelease, null, NoRecordFolders.Instance, DiscardChildRecordStreams.Instance, cancel);

        // Resolved first on both branches so an unsupported type fails with this class's named exception.
        var generated = FindGeneratedSerializationType(record.GetType());
        // A path-ambiguous record dispatches through the game's abstract serializer, whose
        // SerializeWithCheck writes MutagenObjectType ahead of the fields, and every other record
        // carries none.
        var serialize = RecordTypeDispatch.For(gameRelease).IsPathAmbiguous(record.GetType())
            ? ResolveCheckedSerializeMethod(gameRelease)
            : ResolveConcreteSerializeMethod(generated);
        var written = (Task)(serialize.Invoke(null, [writer, record, WriterKernel, metaData])
            ?? throw new InvalidOperationException($"Expected '{serialize.Name}' to return a Task."));
        InlineSerialization.Finished(written);
        WriterKernel.Finalize(streamPackage, writer);

        // No \r anywhere: the kernel's indentation uses the platform newline. No trailing newline:
        // Finalize writes the closing brace and nothing after, as does the source tree, so adding
        // one would diverge from the whole-mod door's document shape.
        return [.. buffer.ToArray().Where(b => b != (byte)'\r')];
    }

    /// <summary>The instance the codec builds for an empty document of a Loqui class: every member
    /// at its declared default. A major record's empty document is its FormKey alone, the identity
    /// the codec requires first.</summary>
    public static object DeserializeEmpty(Type loquiType, GameRelease gameRelease) =>
        DeserializeText(loquiType, typeof(IMajorRecordGetter).IsAssignableFrom(loquiType) ? EmptyMajorRecord : "{}", gameRelease);

    /// <summary>The empty document of a major record: the identity the codec requires first.</summary>
    public const string EmptyMajorRecord = "{\"FormKey\":\"Null\"}";

    /// <summary>The document of an empty instance of <paramref name="loquiType"/> carrying
    /// <paramref name="identity"/> alone, so a caller places a container level rather than
    /// constructing one. A minted document fed back as the identity is its round trip.</summary>
    public static string BlankDocument(Type loquiType, GameRelease gameRelease, JsonObject identity)
    {
        var instance = DeserializeText(loquiType, identity.ToJsonString(), gameRelease);
        var bytes = SerializeCore(instance, gameRelease, CancellationToken.None);
        return Encoding.UTF8.GetString(bytes);
    }

    /// <summary>The instance the codec builds for <paramref name="json"/> read as a Loqui class,
    /// which is how a fact about the class is asked of the codec rather than of reflection.</summary>
    public static object DeserializeText(Type loquiType, string json, GameRelease gameRelease)
    {
        using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json), writable: false);
        return DeserializeObject(stream, gameRelease,
            readerType => ResolveConcreteDeserializeMethod(loquiType, readerType), CancellationToken.None);
    }

    private static IMajorRecord DeserializeCore(
        Stream stream, GameRelease gameRelease, string? recordType, CancellationToken cancel)
    {
        // The reverse of SerializeCore's dispatch, driven by the same RecordTypeDispatch fact so
        // the two directions cannot disagree. An unknown recordType reads as ambiguous, so it takes
        // the self-describing path and fails loudly rather than constructing a guessed type.
        var dispatch = RecordTypeDispatch.For(gameRelease);
        var record = DeserializeObject(stream, gameRelease,
            readerType => recordType is not null
                && dispatch.ConcreteFor(recordType) is { } concrete
                && !dispatch.IsPathAmbiguous(recordType)
                    ? ResolveConcreteDeserializeMethod(concrete, readerType)
                    : ResolveCheckedDeserializeMethod(gameRelease, readerType),
            cancel);
        return (IMajorRecord)record;
    }

    private static object DeserializeObject(
        Stream stream, GameRelease gameRelease, Func<Type, MethodInfo> resolve, CancellationToken cancel)
    {
        var streamPackage = new StreamPackage(stream, string.Empty);
        var reader = ReaderKernel.GetNewObject(streamPackage);
        var metaData = new SerializationMetaData(gameRelease, null, null, null, cancel);

        var deserialize = resolve(reader.GetType());
        var read = (Task)(deserialize.Invoke(null, [reader, ReaderKernel, metaData])
            ?? throw new InvalidOperationException($"Expected '{deserialize.Name}' to return a Task."));
        try
        {
            InlineSerialization.Finished(read);
        }
        catch (Exception ex) when (ex is NotImplementedException or NullReferenceException)
        {
            // Two upstream routes to one failure: NotImplementedException is the generated dispatch's
            // "Unknown object name"; NullReferenceException is the kernel's GetNextType returning null
            // for a name that resolves to no Type. Deliberately narrow so nothing else is relabelled.
            throw new RecordTypeSerializationUnsupportedException(
                $"No record type in this game's schema matches the document's MutagenObjectType. {ex.Message}", ex);
        }

        // "Result": Task<T> for a T only known at runtime, so nameof(Task<object>.Result) would
        // name the banned property; the already-awaited value comes back through reflection instead.
        var resultProperty = read.GetType().GetProperty("Result")
            ?? throw new InvalidOperationException($"Expected '{read.GetType().Name}' to declare 'Result'.");
        return resultProperty.GetValue(read)
            ?? throw new InvalidOperationException("Expected the deserialized record to be non-null.");
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
        LookupGeneratedSerializationType(recordType)
            ?? throw new RecordTypeSerializationUnsupportedException(recordType, null, null);

    private const string OverlaySuffix = "BinaryOverlay";

    // Under FilePerRecord a container writes each non-embedded child (a worldspace's blocks) to its
    // own file via StreamCreator. A block level is its own source unit, so its bytes go nowhere.
    private sealed class DiscardChildRecordStreams : ICreateStream
    {
        internal static readonly DiscardChildRecordStreams Instance = new();

        public Stream GetStreamFor(IFileSystem fileSystem, FilePath path, bool write) => Stream.Null;
    }

    // An overlay reader's runtime type is "<ConcreteSetterName>BinaryOverlay"; stripping that one
    // suffix is the only safe normalization: an interface scan matched an ancestor's narrower
    // serializer and silently produced truncated text.
    private static Type? LookupGeneratedSerializationType(Type recordType) =>
        LookupGeneratedType(recordType, recordType.Name)
        ?? (recordType.Name.EndsWith(OverlaySuffix, StringComparison.Ordinal)
            ? LookupGeneratedType(recordType, recordType.Name[..^OverlaySuffix.Length])
            : null);

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
