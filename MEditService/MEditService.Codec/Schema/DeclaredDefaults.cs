using System.Collections.Concurrent;
using System.Reflection;
using MEditService.Codec.Serialization;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>What a member holds in the instance the codec builds from an empty document: the
/// declared default the codec omits on write, so an absent member reads as this. Asked of the
/// codec, never a hand-built object.</summary>
internal sealed class DeclaredDefaults(GameRelease release, ILogger logger)
{
    internal const string RefusalPrefix = "SchemaReflector: declared defaults unavailable";

    private readonly ConcurrentDictionary<Type, object?> _instances = new();

    private static readonly RecordTextCodec Codec = new(Microsoft.Extensions.Logging.Abstractions.NullLogger<RecordTextCodec>.Instance);

    /// <summary>The other members the codec spells the bit under: Mutagen's flag views over one raw
    /// integer, cleared by a patch so the reader takes the raw alone. Asked by writing the bit and
    /// reading back.</summary>
    internal IReadOnlyList<string> MembersAliasing(Type getterInterface, string backingMember, long bit)
    {
        if (ReflectedTypes.GetSetterType(getterInterface) is not { } setter
            || LoquiUnions.ConcreteUnder(setter) is not { IsGenericTypeDefinition: false } concrete
            || !typeof(IMajorRecordGetter).IsAssignableFrom(concrete))
        {
            return [];
        }
        var flagged = TopLevelMembers(concrete, $"{{\"FormKey\":\"Null\",\"{backingMember}\":{bit}}}");
        var empty = TopLevelMembers(concrete, RecordTextCodec.EmptyMajorRecord);
        return [.. flagged.Except(empty, StringComparer.Ordinal).Where(m => m != backingMember)];
    }

    private HashSet<string> TopLevelMembers(Type concrete, string json)
    {
        var instance = (IMajorRecordGetter)RecordTextCodec.DeserializeText(concrete, json, release);
        var bytes = Codec.SerializeToBytes(instance, release);
        using var document = System.Text.Json.JsonDocument.Parse(bytes);
        return [.. document.RootElement.EnumerateObject().Select(p => p.Name)];
    }

    public object? Of(PropertyInfo prop)
    {
        var owner = _instances.GetOrAdd(ReflectedTypes.DeclaringTypeOf(prop), Instance);
        return owner == null ? null : ReflectedTypes.ReadOrNull(owner, prop);
    }

    private object? Instance(Type getterInterface)
    {
        // An open generic would need closing, a construction the codec does not own; no such class
        // declares a default.
        if (ReflectedTypes.GetSetterType(getterInterface) is not { } setter
            || LoquiUnions.ConcreteUnder(setter) is not { IsGenericTypeDefinition: false } concrete)
            return null;
        try
        {
            return RecordTextCodec.DeserializeEmpty(concrete, release);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogWarning(ex, "{Prefix}: the codec refused an empty document for {Type}", RefusalPrefix, concrete.FullName);
            return null;
        }
    }
}
