using System.Collections.Concurrent;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>Mutagen's serializer writes an alias or package-data index of 0 as nothing and reads nothing
/// as no index, which the serializer then cannot write. A read fills that index back in as 0.</summary>
public static class AbsentIndexes
{
    private static readonly RecordGraph FormLinksOrIndexes = new(type => FormLinkOrIndexInterface(type) is not null);

    public static T Fill<T>(T graph) where T : notnull
    {
        FormLinksOrIndexes.ForEach(graph, FillIndex);
        return graph;
    }

    private static void FillIndex(object formLinkOrIndex)
    {
        var @interface = FormLinkOrIndexInterface(formLinkOrIndex.GetType())
            ?? throw new InvalidOperationException($"Expected '{formLinkOrIndex.GetType().Name}' to implement IFormLinkOrIndex<>.");
        var usesLink = typeof(IFormLinkOrIndexGetter<>).MakeGenericType(@interface.GetGenericArguments())
            .GetMethod(nameof(IFormLinkOrIndexGetter<IMajorRecordGetter>.UsesLink))
            ?? throw new InvalidOperationException($"Expected '{@interface.Name}' to declare UsesLink.");
        if ((bool)(usesLink.Invoke(formLinkOrIndex, null) ?? true)) return;
        var index = @interface.GetProperty(nameof(IFormLinkOrIndex<IMajorRecordGetter>.Index))
            ?? throw new InvalidOperationException($"Expected '{@interface.Name}' to declare Index.");
        if (index.GetValue(formLinkOrIndex) is null) index.SetValue(formLinkOrIndex, 0u);
    }

    private static readonly ConcurrentDictionary<Type, Type?> InterfaceByType = new();

    private static Type? FormLinkOrIndexInterface(Type type) => InterfaceByType.GetOrAdd(type, declared =>
        declared.GetInterfaces().Prepend(declared).FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IFormLinkOrIndex<>)));
}
