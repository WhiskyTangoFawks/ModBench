using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

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
    public void ANumericMemberWithADeclaredDefault_SpellsIt_BecauseTheCodecOmitsAMemberEqualToMutagensDeclaredDefaultNotTheClrZero()
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
        var conditionsElement = Schemas["cobj"].RecordColumns.Single(c => c.Name == "Conditions").ToFieldMetadata().ElementType
            ?? throw new InvalidOperationException("Expected 'Conditions' to have an array element type.");
        var data = Member(conditionsElement, "Data");

        Assert.Equal("Edited", Member(property, "Flags").Default);
        Assert.Equal("Subject", Member(data, "RunOnType").Default);
    }

    [Fact]
    public void AViewPutsTheDeclaredDefaultBack()
    {
        var priority = Schemas["dial"].RecordColumns.Single(c => c.Name == "Priority");

        Assert.Equal(50, AsLong(priority.Field.Default));
        Assert.Equal("50", priority.ViewDefaultLiteral);
    }

    [Theory]
    [InlineData("ligh", "Color", "#00000000")]
    [InlineData("mato", "ProjectionVector", "0, 0, 0")]
    [InlineData("race", "Unknown", "0x0000000000000000")]
    public void AColorVectorOrHexMember_NamesTheCodecsSpellingOfItsZero_BecauseItHasNoWireZeroOfItsOwnAndPlainZeroIsNotItsSpelling(string table, string column, string zero)
    {
        Assert.Equal(zero, Schemas[table].RecordColumns.Single(c => c.Name == column).Field.Default);
    }

    private const string DeclaredDefaultsRefusalPrefix = "SchemaReflector: declared defaults unavailable";

    [Fact]
    public void TheCodecAnswersAnEmptyDocumentForEveryOwnerTheWalkReaches()
    {
        var entries = new List<LogEntry>();
        using var factory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(entries)));
        new SchemaReflector(factory.CreateLogger<SchemaReflector>()).GetSchemas(GameRelease.Fallout4);
        Assert.True(entries.Count > 0, "Expected the collector to receive the walk's own trace; a collector wired to nothing would find zero refusals too.");

        var refused = entries.Where(e => e.Message.StartsWith(DeclaredDefaultsRefusalPrefix, StringComparison.Ordinal)).Select(e => e.Message).Distinct().ToList();
        Assert.True(refused.Count == 0, string.Join("\n", refused));
    }
}
