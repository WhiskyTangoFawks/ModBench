using System.Collections.Concurrent;
using System.Reflection;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Schema;

/// <summary>The value a member has in the instance the codec builds from an empty document: the
/// default Mutagen declares, which the codec omits on write, so a document's absent member reads
/// as this. Asked through the codec, never by constructing a Mutagen class by hand.</summary>
internal sealed class DeclaredDefaults(GameRelease release, ILogger logger)
{
    internal const string RefusalPrefix = "SchemaReflector: declared defaults unavailable";

    private readonly ConcurrentDictionary<Type, object?> _instances = new();

    internal object? Of(PropertyInfo prop)
    {
        var owner = _instances.GetOrAdd(prop.DeclaringType!, Instance);
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
            return RecordTextCodec.DeserializeEmptyAsync(concrete, release).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "{Prefix}: the codec refused an empty document for {Type}", RefusalPrefix, concrete.FullName);
            return null;
        }
    }
}
