using System.Collections;
using System.Collections.Concurrent;
using System.Drawing;
using System.Globalization;
using System.Reflection;
using MEditService.Codec.Schema;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Codec.Serialization;

/// <summary>Mutagen's versioning breaks: bytes that end at a break hold no member past it. Mutagen's
/// copy stops at a set break, so what a copy of a filled object leaves at its default is unheld.</summary>
internal static class VersioningBreaks
{
    public const string Member = "Versioning";

    private const string EnumName = "VersioningBreaks";

    private const int FilledDepth = 2;

    private static readonly FormKey Elsewhere = new(ModKey.FromFileName("Elsewhere.esp"), 0x800);

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> None = new Dictionary<string, IReadOnlyList<string>>();

    private static readonly ConcurrentDictionary<Type, IReadOnlyDictionary<string, IReadOnlyList<string>>> UnheldByClass = new();

    /// <summary>Each member of <paramref name="loquiClass"/> a break leaves unheld, with every break that
    /// does, spelled <c>Versioning.Break0</c>.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> UnheldWhen(Type loquiClass) =>
        UnheldByClass.GetOrAdd(loquiClass, Derive);

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> Derive(Type loquiClass)
    {
        if (loquiClass.GetProperty(Member) is not { PropertyType: { IsEnum: true, Name: EnumName } breaks } versioning
            || LoquiUnions.ConcreteUnder(loquiClass) is not { IsGenericTypeDefinition: false } concrete
            || ReflectedTypes.GetOwnGetterType(concrete) is not { } getter)
        {
            return None;
        }
        var copy = DeepCopyIn(concrete, getter);
        var fresh = New(concrete);
        var settable = Settable(concrete).Where(p => p.Name != Member).ToList();
        var filled = Filled(concrete, 0);
        if (settable.FirstOrDefault(m => Same(m.GetValue(filled), m.GetValue(fresh))) is { } unfilled)
            throw new InvalidOperationException($"Expected a value of {concrete.Name}.{unfilled.Name} ({unfilled.PropertyType.Name}) other than its default.");

        HashSet<PropertyInfo> LeftAtDefault(object under)
        {
            versioning.SetValue(filled, under);
            var copied = New(concrete);
            copy.Invoke(null, [copied, filled, null, null]);
            return [.. settable.Where(m => Same(m.GetValue(copied), m.GetValue(fresh)))];
        }

        var neverCopied = LeftAtDefault(Enum.ToObject(breaks, 0));
        var unheld = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var flag in Enum.GetValues(breaks))
        {
            foreach (var member in LeftAtDefault(flag).Except(neverCopied).Select(member => member.Name))
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

    private static IEnumerable<PropertyInfo> Settable(Type type) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetIndexParameters().Length == 0 && p.SetMethod is { IsPublic: true });

    private static object New(Type type) =>
        Activator.CreateInstance(type) ?? throw new InvalidOperationException($"Expected {type.Name} to construct.");

    private static object Filled(Type loquiClass, int depth)
    {
        var filled = New(loquiClass);
        if (depth > FilledDepth) return filled;
        foreach (var member in Settable(loquiClass).Where(p => p.Name != Member))
            member.SetValue(filled, Other(member.PropertyType, member.GetValue(filled), depth + 1));
        return filled;
    }

    // Covers each member type a versioned class declares in the games the codec reads.
    private static object Other(Type type, object? held, int depth)
    {
        var core = Nullable.GetUnderlyingType(type) ?? type;
        if (core == typeof(bool)) return held is not true;
        if (core.IsEnum)
            return Enum.GetValues(core).Cast<object>().FirstOrDefault(value => !value.Equals(held))
                ?? Enum.ToObject(core, Convert.ToInt64(held, CultureInfo.InvariantCulture) + 1);
        if (core.IsPrimitive)
        {
            var one = Convert.ChangeType(1, core, CultureInfo.InvariantCulture);
            return one.Equals(held) ? Convert.ChangeType(2, core, CultureInfo.InvariantCulture) : one;
        }
        if (core == typeof(string)) return $"{held}x";
        if (core == typeof(Color)) return Color.FromArgb(1, 2, 3, 4);
        if (core.IsGenericType)
        {
            var definition = core.GetGenericTypeDefinition();
            var element = core.GetGenericArguments()[0];
            if (definition == typeof(MemorySlice<>))
            {
                var array = Array.CreateInstance(element, 1);
                array.SetValue(Other(element, null, depth), 0);
                return Activator.CreateInstance(core, array) ?? throw new InvalidOperationException($"Expected {core.Name} to construct.");
            }
            if (typeof(IFormLinkGetter).IsAssignableFrom(core))
                return Activator.CreateInstance(typeof(FormLink<>).MakeGenericType(element), Elsewhere)
                    ?? throw new InvalidOperationException($"Expected a FormLink of {element.Name} to construct.");
            if (typeof(IList).IsAssignableFrom(core))
            {
                var list = (IList)New(core);
                list.Add(Other(element, null, depth));
                return list;
            }
        }
        if (core.IsValueType)
        {
            var constructor = core.GetConstructors().MaxBy(c => c.GetParameters().Length)
                ?? throw new InvalidOperationException($"Expected {core.Name} to declare a constructor.");
            return constructor.Invoke([.. constructor.GetParameters().Select(p => Other(p.ParameterType, null, depth))]);
        }
        if (ReflectedTypes.GetSetterType(core) is { } loqui && LoquiUnions.ConcreteUnder(loqui) is { IsGenericTypeDefinition: false } concrete)
            return Filled(concrete, depth);
        throw new InvalidOperationException($"No value of {type.Name} other than its default is known.");
    }

    private static bool Same(object? a, object? b) =>
        a is IEnumerable left and not string && b is IEnumerable right
            ? left.Cast<object?>().SequenceEqual(right.Cast<object?>())
            : Equals(a, b);
}
