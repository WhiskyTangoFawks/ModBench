using System.Reflection;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Serialization;

/// <summary>Derived is only better than tabulated if the derivation is swept: a rule read off
/// reflection can be quietly wrong for a whole class of types and look right for two.</summary>
public sealed class RecordTypeAmbiguityTests
{
    private static readonly RecordTypeDispatch Dispatch = RecordTypeDispatch.For(GameRelease.Fallout4);

    [Fact]
    public void ConcreteFor_ResolvesEveryConcreteMajorRecordTypeByItsClrName()
    {
        var unresolved = ConcreteMajorRecordTypes()
            .Where(t => Dispatch.ConcreteFor(t.Name) != t)
            .Select(t => t.Name)
            .ToList();

        Assert.NotEmpty(ConcreteMajorRecordTypes());
        Assert.Empty(unresolved);
    }

    [Fact]
    public void ConcreteFor_ResolvesEverySchemaTableName()
    {
        // "Header" is the one table with no document to reconstitute: a ModHeader never reaches this codec
        // and its Body is null. Excluded by name rather than by predicate, so a second unresolvable name
        // cannot hide behind a rule that grew.
        var tableNames = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Keys
            .Where(n => n != "header")
            .ToList();

        var unresolved = tableNames.Where(n => Dispatch.ConcreteFor(n) is null).ToList();

        Assert.NotEmpty(tableNames);
        Assert.Empty(unresolved);
    }

    [Theory]
    [InlineData("glob", true)]
    [InlineData("globalfloat", true)]
    [InlineData("gmst", true)]
    [InlineData("weap", false)]
    [InlineData("npc_", false)]
    [InlineData("cell", false)]
    [InlineData("wrld", false)]
    [InlineData("refr", false)]
    [InlineData("Landscape", false)]
    public void IsPathAmbiguous_MatchesTheWholeModDoorsOwnPolicy(string recordType, bool expected) =>
        Assert.Equal(expected, Dispatch.IsPathAmbiguous(recordType));

    // Ingest hands the serializer binary-overlay getters, whose runtime type does not derive from
    // the concrete setter class, so the rule cannot be assignability against the group element.
    [Fact]
    public void IsPathAmbiguous_ForAnOverlayReadersOwnRuntimeType_AnswersAsForTheConcreteType()
    {
        var overlay = typeof(Fallout4Mod).Assembly.GetType("Mutagen.Bethesda.Fallout4.GlobalFloatBinaryOverlay", throwOnError: true)!;

        Assert.True(Dispatch.IsPathAmbiguous(overlay));
        Assert.False(Dispatch.IsPathAmbiguous(
            typeof(Fallout4Mod).Assembly.GetType("Mutagen.Bethesda.Fallout4.WeaponBinaryOverlay", throwOnError: true)!));
    }

    [Fact]
    public void TheAbstractGroupElementRule_AgreesWithSignaturesThatSeveralConcreteTypesShare()
    {
        var bySignature = ConcreteMajorRecordTypes()
            .GroupBy(SignatureOf, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var shared = bySignature.Where(g => g.Count() > 1).Select(g => g.Key).OrderBy(k => k, StringComparer.Ordinal);
        var ambiguous = bySignature
            .Where(g => g.Any(t => Dispatch.IsPathAmbiguous(t)))
            .Select(g => g.Key)
            .OrderBy(k => k, StringComparer.Ordinal);

        Assert.NotEmpty(shared);
        Assert.Equal(shared, ambiguous);
    }

    private static List<Type> ConcreteMajorRecordTypes() =>
        [.. typeof(Fallout4Mod).Assembly.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface)
            .Where(t => typeof(IMajorRecordGetter).IsAssignableFrom(t))
            .Where(t => t.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static) is not null)];

    private static string SignatureOf(Type type) =>
        ((RecordType)type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!).Type;
}
