using System.Collections.Concurrent;
using System.Reflection;
using MEditService.Codec.Schema;

namespace MEditService.Codec.Serialization;

/// <summary>Mutagen's versioning breaks: bytes that end at a break hold no member past it. Mutagen's
/// own copy stops at a set break, so the members it reads under one are the ones held.</summary>
internal static class VersioningBreaks
{
    public const string Member = "Versioning";

    private const string EnumName = "VersioningBreaks";

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> None = new Dictionary<string, IReadOnlyList<string>>();

    private static readonly ConcurrentDictionary<Type, IReadOnlyDictionary<string, IReadOnlyList<string>>> UnheldByClass = new();

    /// <summary>Each member of <paramref name="loquiClass"/> a break leaves unheld, with every break that
    /// does, spelled <c>Versioning.Break0</c>.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> UnheldWhen(Type loquiClass) =>
        UnheldByClass.GetOrAdd(loquiClass, Derive);

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> Derive(Type loquiClass)
    {
        if (loquiClass.GetProperty(Member)?.PropertyType is not { IsEnum: true, Name: EnumName } breaks
            || LoquiUnions.ConcreteUnder(loquiClass) is not { IsGenericTypeDefinition: false } concrete
            || ReflectedTypes.GetOwnGetterType(concrete) is not { } getter)
        {
            return None;
        }
        var copy = DeepCopyIn(concrete, getter);
        var held = ReadByCopy(concrete, getter, copy, Enum.ToObject(breaks, 0));
        var unheld = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var flag in Enum.GetValues(breaks))
        {
            foreach (var member in held.Except(ReadByCopy(concrete, getter, copy, flag)))
            {
                if (!unheld.TryGetValue(member, out var under)) unheld[member] = under = [];
                under.Add($"{Member}.{flag}");
            }
        }
        return unheld.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value, StringComparer.Ordinal);
    }

    // The mixin's copy from a getter: DeepCopyIn(lhs, rhs, ErrorMaskBuilder?, TranslationCrystal?).
    private static MethodInfo DeepCopyIn(Type concrete, Type getter) =>
        concrete.Assembly.GetType($"{concrete.Namespace}.{concrete.Name}MixIn")?.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .FirstOrDefault(method => method.Name == "DeepCopyIn" && method.GetParameters() is { Length: 4 } parameters
                && parameters[1].ParameterType == getter && !parameters[2].ParameterType.IsByRef)
        ?? throw new InvalidOperationException($"Expected Mutagen to declare a DeepCopyIn from {getter.Name}.");

    private static HashSet<string> ReadByCopy(Type concrete, Type getter, MethodInfo copy, object versioning)
    {
        var rhs = DispatchProxy.Create(getter, typeof(MemberReadRecorder));
        var recorder = (MemberReadRecorder)rhs;
        recorder.Target = Activator.CreateInstance(concrete);
        recorder.Versioning = versioning;
        copy.Invoke(null, [Activator.CreateInstance(concrete), rhs, null, null]);
        return recorder.Read;
    }
}
