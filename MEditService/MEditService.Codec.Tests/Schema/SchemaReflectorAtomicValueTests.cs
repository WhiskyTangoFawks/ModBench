using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Indexing;

public class SchemaReflectorAtomicValueTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    private ColumnSpec Column(string table, string column) =>
        _reflector.GetSchemas(GameRelease.Fallout4)[table].RecordColumns.Single(c => c.Name == column);

    private FieldMetadata FieldAt(string table, string dottedPathWithArrayHopsAsBrackets)
    {
        var hops = dottedPathWithArrayHopsAsBrackets.Split('.');
        var field = Column(table, hops[0]).ToFieldMetadata();
        foreach (var hop in hops[1..])
        {
            field = hop == "[]"
                ? field.ElementType ?? throw new InvalidOperationException($"Expected '{field.Name}' to be an array.")
                : (field.Fields ?? throw new InvalidOperationException($"Expected '{field.Name}' to have members.")).Single(f => f.Name == hop);
        }
        return field;
    }

    [Fact]
    public void Color_IsAColorLeaf_WithNoMembersOfItsOwn_AsXEditDefinesLightColorAsWbByteColors()
    {
        var color = Column("ligh", "Color");

        Assert.Equal("color", color.ApiType);
        Assert.Null(color.Field.SubFields);
        Assert.True(color.IsViewable);
    }

    [Fact]
    public void Color_NestedInsideAStruct_IsAColorLeaf_ReachedBelowAColumnNotOnlyAtTheTopLevel()
    {
        var lighting = Column("cell", "Lighting");
        var subFields = lighting.Field.SubFields
            ?? throw new InvalidOperationException("Expected 'cell.Lighting' to have sub-fields.");
        var ambient = subFields.Single(f => f.Name == "AmbientColor");

        Assert.Equal("color", ambient.ApiType);
        Assert.Null(ambient.SubFields);
    }

    [Theory]
    [InlineData("kywd", "Color", true)]
    [InlineData("ligh", "Color", true)]
    [InlineData("cell", "Lighting.AmbientColor", true)]
    [InlineData("wthr", "LightningColor", false)]
    [InlineData("mato", "SinglePassColor", false)]
    [InlineData("refr", "Primitive.Color", false)]
    [InlineData("lens", "Sprites.[].Data.Tint", false)]
    public void AColorHoldsAlpha_AsMutagensBinaryTranslationKeepsIt(string table, string path, bool holdsAlpha)
    {
        var color = FieldAt(table, path);

        Assert.Equal("color", color.Type);
        Assert.Equal(holdsAlpha, color.HoldsAlpha);
    }

    [Fact]
    public void NoLeafButAColorHoldsAlpha()
    {
        Assert.False(Column("kywd", "EditorID").ToFieldMetadata().HoldsAlpha);
    }

    private const string HeldAlphaRefusalPrefix = "SchemaReflector: a colour's alpha unavailable";

    [Fact]
    public void MutagensBinaryTranslationAnswersForEveryColorTheWalkReaches()
    {
        var entries = new List<LogEntry>();
        using var factory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(entries)));
        new SchemaReflector(factory.CreateLogger<SchemaReflector>()).GetSchemas(GameRelease.Fallout4);
        Assert.True(entries.Count > 0, "Expected the collector to receive the walk's own trace; a collector wired to nothing would find zero refusals too.");

        var unanswered = entries.Where(e => e.Message.StartsWith(HeldAlphaRefusalPrefix, StringComparison.Ordinal)).Select(e => e.Message).Distinct().ToList();
        Assert.True(unanswered.Count == 0, string.Join("\n", unanswered));
    }
}
