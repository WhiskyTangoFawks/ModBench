using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public sealed class ContainerSlotElementTypesTests
{
    private const GameRelease Release = GameRelease.Fallout4;

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas = SharedSchemaReflector.Instance.GetSchemas(Release);
    private static readonly ContainerDocuments Documents = new(Release, Schemas);

    private sealed record Slot(Type Parent, string Name, Type Declared, string? TypeOfAnUnspelledChild);

    [Fact]
    public void EverySlot_TypesAChildThatSpellsNoTypeAsTheTypeItsOwnMemberDeclares()
    {
        var slots = ChildSlots().ToList();

        Assert.NotEmpty(slots);
        Assert.All(slots, slot => Assert.Equal(DeclaredTable(slot.Declared), slot.TypeOfAnUnspelledChild));
    }

    [Fact]
    public void NoTwoContainersSpellAnEmbeddedSlotTheSameAndMeanDifferentTypes_BecauseTheSlotNameAloneNamesAChildFoundBelowAKnownLevel()
    {
        var embedded = ContainerChildFields.EmbeddedSlotsFor(GameCategory.Fallout4);
        var ambiguous = ChildSlots()
            .Where(slot => embedded.Contains((slot.Parent.Name, slot.Name)))
            .GroupBy(slot => slot.Name, slot => slot.TypeOfAnUnspelledChild, StringComparer.Ordinal)
            .Where(group => group.Distinct(StringComparer.Ordinal).Count() > 1)
            .Select(group => $"{group.Key} => {string.Join("/", group.Distinct(StringComparer.Ordinal))}")
            .ToList();

        Assert.NotEmpty(embedded);
        Assert.Empty(ambiguous);
    }

    private static IEnumerable<Slot> ChildSlots() =>
        RecordTypes().SelectMany(parent => (ContainerChildFields.EnumerateChildFieldsFor(parent) ?? [])
            .Select(name => new Slot(
                parent, name, ElementTypeOf(parent.GetProperty(name)?.PropertyType
                    ?? throw new InvalidOperationException($"Expected '{parent.Name}' to declare property '{name}'.")),
                TypeOfAnUnspelledChild(parent, name))));

    private static string? TypeOfAnUnspelledChild(Type parent, string slot)
    {
        using var document = JsonDocument.Parse($$$"""{"FormKey":"000800:Sweep.esp","{{{slot}}}":{"FormKey":"000801:Sweep.esp"}}""");
        return Documents.ChildrenOf(RecordTableName.Of(parent, Schemas), document.RootElement).SingleOrDefault().RecordType;
    }

    private static string? DeclaredTable(Type declared) =>
        typeof(IMajorRecordGetter).IsAssignableFrom(declared) && !declared.IsAbstract ? RecordTableName.Of(declared, Schemas) : null;

    private static IEnumerable<Type> RecordTypes() =>
        ReferencedGameModules.Sweep()
            .SelectMany(module => module.GetTypes())
            .Where(type => type.IsClass && !type.IsAbstract && type.IsPublic
                           && typeof(IMajorRecord).IsAssignableFrom(type));

    private static Type ElementTypeOf(Type slotType) =>
        slotType.GetInterfaces()
            .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            .Select(i => i.GetGenericArguments()[0])
            .FirstOrDefault()
        ?? slotType;
}
