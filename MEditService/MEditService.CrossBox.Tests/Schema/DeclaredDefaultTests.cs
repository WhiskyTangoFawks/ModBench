using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.Queries;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Schema;

/// <summary>The codec omits a member equal to the default Mutagen declares, not the CLR zero
/// (VirtualMachineAdapter.ObjectFormat is 2 when absent), so the metadata spells that default and
/// every absent-member rule reads it (ADR-0005).</summary>
public sealed class DeclaredDefaultTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static FieldMetadata Vmad => Schemas["npc_"].RecordColumns.Single(c => c.Name == "VirtualMachineAdapter").ToFieldMetadata();

    private static FieldMetadata Member(FieldMetadata owner, string name) =>
        (owner.Fields ?? throw new InvalidOperationException($"Expected '{owner.Name}' to have sub-fields."))
            .Single(f => f.Name == name);

    private static long AsLong(object? value) => JsonSerializer.SerializeToElement(value).GetInt64();

    [Fact]
    public void ANumericMemberWithADeclaredDefault_SpellsIt()
    {
        Assert.Equal(2, AsLong(Member(Vmad, "ObjectFormat").Default));
        Assert.Equal(6, AsLong(Member(Vmad, "Version").Default));
    }

    [Fact]
    public void ANumericMemberWhoseDefaultIsZero_SpellsNothing()
    {
        var script = Member(Vmad, "Scripts").ElementType
            ?? throw new InvalidOperationException("Expected 'Scripts' to have an array element type.");

        Assert.Null(Member(script, "Name").Default);
        Assert.Null(Schemas["npc_"].RecordColumns.Single(c => c.Name == "HeightMin").Field.Default);
    }

    [Fact]
    public void AnEnumMember_AlwaysNamesItsDefault_DeclaredOrZero()
    {
        var scriptsElement = Member(Vmad, "Scripts").ElementType
            ?? throw new InvalidOperationException("Expected 'Scripts' to have an array element type.");
        var property = Member(scriptsElement, "Properties").ElementType
            ?? throw new InvalidOperationException("Expected 'Properties' to have an array element type.");
        var conditionsElementSpec = Schemas["cobj"].RecordColumns.Single(c => c.Name == "Conditions").Field.ElementSpec
            ?? throw new InvalidOperationException("Expected 'Conditions' to have an array element spec.");
        var data = Member(conditionsElementSpec.ToFieldMetadata(), "Data");

        Assert.Equal("Edited", Member(property, "Flags").Default);
        Assert.Equal("Subject", Member(data, "RunOnType").Default);
    }

    // DialogTopic.Priority is declared 50, so a view puts 50 back where the codec omitted it.
    [Fact]
    public void AViewPutsTheDeclaredDefaultBack()
    {
        var priority = Schemas["dial"].RecordColumns.Single(c => c.Name == "Priority");

        Assert.Equal(50, AsLong(priority.Field.Default));
        Assert.Equal("50", priority.ViewDefaultLiteral);
    }

    // A colour, vector or hex member has no wire zero of its own — 0 is not "#00000000" — so the
    // metadata names the codec's own spelling of it, as an enum names its zero member.
    [Theory]
    [InlineData("ligh", "Color", "#00000000")]
    [InlineData("mato", "ProjectionVector", "0, 0, 0")]
    [InlineData("race", "Unknown", "0x0000000000000000")]
    public void AColorVectorOrHexMember_NamesTheCodecsSpellingOfItsZero(string table, string column, string zero)
    {
        Assert.Equal(zero, Schemas[table].RecordColumns.Single(c => c.Name == column).Field.Default);
    }

    // Mirrors DeclaredDefaults.RefusalPrefix, an internal: the prefix is a log message shape, not a
    // type this test can reach without a grant.
    private const string DeclaredDefaultsRefusalPrefix = "SchemaReflector: declared defaults unavailable";

    [Fact]
    public void TheCodecAnswersAnEmptyDocumentForEveryOwnerTheWalkReaches()
    {
        var entries = new List<LogEntry>();
        using var factory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(entries)));
        new SchemaReflector(factory.CreateLogger<SchemaReflector>()).GetSchemas(GameRelease.Fallout4);

        var refused = entries.Where(e => e.Message.StartsWith(DeclaredDefaultsRefusalPrefix, StringComparison.Ordinal)).Select(e => e.Message).Distinct().ToList();
        Assert.True(refused.Count == 0, string.Join("\n", refused));
    }

    // The pin: with the real schema, an npc_ omitting ObjectFormat is the same as one spelling 2,
    // and one spelling 0 is a conflict.
    [Theory]
    [InlineData("""{"ObjectFormat":2}""", ConflictThis.IdenticalToMaster)]
    [InlineData("""{"ObjectFormat":0}""", ConflictThis.Override)]
    public void Classify_AbsentObjectFormat_IsTheDeclaredTwo(string overrideJson, ConflictThis expected)
    {
        var meta = Vmad;
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null, [new FieldValue(meta, JsonSerializer.Deserialize<JsonElement>("{}"))], "Data");
        var spelled = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null, [new FieldValue(meta, JsonSerializer.Deserialize<JsonElement>(overrideJson))], "Data");

        var result = new ConflictClassifier().Classify([master, spelled], new Dictionary<string, IReadOnlyList<string>>(), GameRelease.Fallout4);
        var objectFormat = (Assert.Single(result.Diffs).Children
            ?? throw new InvalidOperationException("Expected the ObjectFormat diff to have children."))
            .Single(c => c.FieldName == "ObjectFormat");

        Assert.Equal(expected, objectFormat.CellStates["B.esp"]);
    }
}
