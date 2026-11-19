using System.Linq.Expressions;
using System.Reflection;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Codec.Tests.Schema;

public sealed class EmbedCustomizationsAreTheDerivedSlotsTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void TheCustomizationsEmbedExactlyTheDerivedSlots_BecauseACustomizationTheDerivationDoesNotNamePutsAChildInADocumentNoEditCanReach(GameRelease release)
    {
        var customized = ReplayEveryCustomizeOfTheSerializationFolderThroughARecordingBuilder(release).Order().ToList();

        Assert.True(customized.Count > 0, "Expected the replay to discover customizations; an empty replay would agree with an empty derivation.");
        Assert.Equal(DerivedEmbeddedSlots(release).Order().ToList(), customized);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4, "Spriggit.Json.Fallout4")]
    [InlineData(GameRelease.SkyrimSE, "Spriggit.Json.Skyrim")]
    [InlineData(GameRelease.Starfield, "Spriggit.Json.Starfield")]
    public void EveryCustomizationTheCodecCompiles_IsItsGamesSpriggitJsonPackages(GameRelease release, string package)
    {
        var customizations = GameCodecs.For(release).GeneratedSerializers.GetTypes()
            .Where(type => type.GetInterfaces().Any(i => i == typeof(ICustomize) || (i.IsGenericType && i.GetGenericTypeDefinition() == typeof(ICustomize<>))))
            .ToList();

        Assert.NotEmpty(customizations);
        Assert.All(customizations, type => Assert.StartsWith(package + ".", type.FullName, StringComparison.Ordinal));
    }

    private static IEnumerable<(string ParentType, string Slot)> DerivedEmbeddedSlots(GameRelease release)
    {
        var types = RecordTypes.For(release);
        return Assembly.Load($"Mutagen.Bethesda.{release.ToCategory()}").GetTypes()
            .Where(type => type is { IsClass: true, IsAbstract: false, IsPublic: true } && typeof(IMajorRecord).IsAssignableFrom(type))
            .SelectMany(type => type.GetProperties()
                .Where(property => types.IsEmbeddedSlot(type.Name, property.Name))
                .Select(property => (type.Name, property.Name)));
    }

    private static IEnumerable<(string ParentType, string Slot)> ReplayEveryCustomizeOfTheSerializationFolderThroughARecordingBuilder(GameRelease release)
    {
        foreach (var found in GameCodecs.For(release).GeneratedSerializers.GetTypes()
                     .Where(type => type is { IsClass: true, IsAbstract: false })
                     .Select(type => (Type: type, Customized: CustomizedType(type)))
                     .Where(found => found.Customized != null))
        {
            var customized = found.Customized
                ?? throw new InvalidOperationException($"Expected '{found.Type.Name}' to name a customized type.");
            var recorder = (IEmbedRecorder)(Activator.CreateInstance(typeof(RecordingBuilder<>).MakeGenericType(customized))
                ?? throw new InvalidOperationException($"Expected RecordingBuilder<{customized.Name}> to be constructible."));
            var customizeFor = typeof(ICustomize<>).MakeGenericType(customized)
                .GetMethod(nameof(ICustomize<IMajorRecordGetter>.CustomizeFor))
                ?? throw new InvalidOperationException($"Expected ICustomize<{customized.Name}> to declare CustomizeFor.");
            customizeFor.Invoke(Activator.CreateInstance(found.Type), [recorder]);

            var parent = customized.IsInterface ? customized.Name[1..^"Getter".Length] : customized.Name;
            foreach (var member in recorder.Embedded) yield return (parent, member);
        }
    }

    private static Type? CustomizedType(Type type) =>
        type.GetInterfaces()
            .FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(ICustomize<>))
            ?.GetGenericArguments()[0];

    private interface IEmbedRecorder
    {
        List<string> Embedded { get; }
    }

    private sealed class RecordingBuilder<TObject> : ICustomizationBuilder<TObject>, IEmbedRecorder
    {
        public List<string> Embedded { get; } = [];

        public ICustomizationBuilder<TObject> EmbedRecordsInSameFile(Expression<Func<TObject, IMajorRecordGetter?>> field) => Record(field);

        public ICustomizationBuilder<TObject> EmbedRecordsInSameFile(Expression<Func<TObject, IReadOnlyList<IMajorRecordGetter>?>> field) => Record(field);

        public ICustomizationBuilder<TObject> Omit<TField>(Expression<Func<TObject, TField>> field) => this;

        public ICustomizationBuilder<TObject> Omit<TField>(Expression<Func<TObject, TField>> field, Func<TObject, TField, bool> predicate) => this;

        public IListSortBuilder<TObject, TItem> SortList<TItem>(Expression<Func<TObject, IEnumerable<TItem>?>> listField) =>
            new IgnoredSort<TObject, TItem>(this);

        private ICustomizationBuilder<TObject> Record(LambdaExpression field)
        {
            var body = field.Body is UnaryExpression converted ? converted.Operand : field.Body;
            Embedded.Add(((MemberExpression)body).Member.Name);
            return this;
        }
    }

    private sealed class IgnoredSort<TObject, TItem>(ICustomizationBuilder<TObject> owner)
        : IListSortBuilder<TObject, TItem>, IListSortFieldChainBuilder<TObject, TItem>
    {
        public IListSortFieldChainBuilder<TObject, TItem> ByField<TField>(Expression<Func<TItem, TField>> itemField) => this;

        public IListSortFieldChainBuilder<TObject, TItem> ThenByField<TField>(Expression<Func<TItem, TField>> itemField) => this;

        public ICustomizationBuilder<TObject> Omit<TField>(Expression<Func<TObject, TField>> field) => owner.Omit(field);

        public ICustomizationBuilder<TObject> Omit<TField>(Expression<Func<TObject, TField>> field, Func<TObject, TField, bool> predicate) =>
            owner.Omit(field, predicate);

        public ICustomizationBuilder<TObject> EmbedRecordsInSameFile(Expression<Func<TObject, IMajorRecordGetter?>> field) =>
            owner.EmbedRecordsInSameFile(field);

        public ICustomizationBuilder<TObject> EmbedRecordsInSameFile(Expression<Func<TObject, IReadOnlyList<IMajorRecordGetter>?>> field) =>
            owner.EmbedRecordsInSameFile(field);

        public IListSortBuilder<TObject, TOther> SortList<TOther>(Expression<Func<TObject, IEnumerable<TOther>?>> listField) =>
            owner.SortList(listField);
    }
}
