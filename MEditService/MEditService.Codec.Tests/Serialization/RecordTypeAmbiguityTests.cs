using System.Reflection;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public sealed class RecordTypeAmbiguityTests
{
    private static readonly RecordTypes Dispatch = RecordTypes.For(GameRelease.Fallout4);

    [Fact]
    public void EveryConcreteMajorRecordClass_NamesItsGrupsTable_SweptBecauseARuleReadOffReflectionCanBeQuietlyWrongForAWholeClassOfTypesAndLookRightForTwo()
    {
        var unresolved = ConcreteMajorRecordTypes()
            .Where(t => !string.Equals(Dispatch.RecordTypeNamed(t.Name), SignatureOf(t), StringComparison.OrdinalIgnoreCase))
            .Select(t => t.Name)
            .ToList();

        Assert.NotEmpty(ConcreteMajorRecordTypes());
        Assert.Empty(unresolved);
    }

    [Fact]
    public void EverySchemaTableName_NamesItself()
    {
        const string HeaderTheOneTableWithNoDocumentToReconstituteExcludedByNameNotPredicateSoASecondUnresolvableNameCannotHideBehindARuleThatGrew = "header";
        var tableNames = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Keys
            .Where(n => n != HeaderTheOneTableWithNoDocumentToReconstituteExcludedByNameNotPredicateSoASecondUnresolvableNameCannotHideBehindARuleThatGrew)
            .ToList();

        var unresolved = tableNames.Where(n => Dispatch.RecordTypeNamed(n) != n).ToList();

        Assert.NotEmpty(tableNames);
        Assert.Empty(unresolved);
    }

    [Theory]
    [InlineData("GlobalFloat", true)]
    [InlineData("GameSettingInt", true)]
    [InlineData("Weapon", false)]
    [InlineData("Npc", false)]
    [InlineData("Cell", false)]
    [InlineData("Worldspace", false)]
    [InlineData("PlacedObject", false)]
    [InlineData("Landscape", false)]
    public void ARecordIsWrittenNamingItsType_WhenItsPathDoesNotSay(string className, bool expected) =>
        Assert.Equal(expected, NamesItsType(ConcreteMajorRecordTypes().Single(t => t.Name == className)));

    [Fact]
    public void TheAbstractGroupElementRule_AgreesWithSignaturesThatSeveralConcreteTypesShare()
    {
        var bySignature = ConcreteMajorRecordTypes()
            .GroupBy(SignatureOf, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var shared = bySignature.Where(g => g.Count() > 1).Select(g => g.Key).OrderBy(k => k, StringComparer.Ordinal);
        var ambiguous = bySignature
            .Where(g => g.Any(NamesItsType))
            .Select(g => g.Key)
            .OrderBy(k => k, StringComparer.Ordinal);

        Assert.NotEmpty(shared);
        Assert.Equal(shared, ambiguous);
    }

    private static bool NamesItsType(Type recordClass)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Ambiguity.esp"), Fallout4Release.Fallout4);
        var record = (IMajorRecordGetter)(System.Activator.CreateInstance(recordClass, mod)
            ?? throw new InvalidOperationException($"Expected '{recordClass.Name}' to construct."));
        using var written = JsonDocument.Parse(RecordTextCodec.SerializeToText(record, GameRelease.Fallout4));
        return written.RootElement.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out _);
    }

    private static List<Type> ConcreteMajorRecordTypes() =>
        [.. typeof(Fallout4Mod).Assembly.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface)
            .Where(t => typeof(IMajorRecordGetter).IsAssignableFrom(t))
            .Where(t => t.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static) is not null)];

    private static string SignatureOf(Type type)
    {
        var field = type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Expected '{type.Name}' to declare a static GrupRecordType field.");
        var value = field.GetValue(null)
            ?? throw new InvalidOperationException($"Expected '{type.Name}'.GrupRecordType to have a value.");
        return ((RecordType)value).Type;
    }
}
