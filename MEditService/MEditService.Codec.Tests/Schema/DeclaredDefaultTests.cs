using System.Text.Json;
using MEditService.Codec.Schema;
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

    private const string DeclaredDefaultsRefusalPrefix = "SchemaReflector: declared defaults unavailable";

    [Fact]
    public void TheCodecAnswersAnEmptyDocumentForEveryOwnerTheWalkReaches()
    {
        var entries = new List<LogEntry>();
        using var factory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(entries)));
        new SchemaReflector(factory.CreateLogger<SchemaReflector>()).GetSchemas(GameRelease.Fallout4);
        // A collector wired to nothing would also find zero refusals below — this is the canary
        // that it received the walk's own trace.
        Assert.NotEmpty(entries);

        var refused = entries.Where(e => e.Message.StartsWith(DeclaredDefaultsRefusalPrefix, StringComparison.Ordinal)).Select(e => e.Message).Distinct().ToList();
        Assert.True(refused.Count == 0, string.Join("\n", refused));
    }
}
