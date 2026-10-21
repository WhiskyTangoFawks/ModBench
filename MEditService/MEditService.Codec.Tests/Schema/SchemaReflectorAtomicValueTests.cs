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

    [Fact]
    public void Color_IsAColorLeaf_WithNoMembersOfItsOwn_AsXEditDefinesLightColorAsWbByteColors()
    {
        Assert.Equal("color", Column("ligh", "Color").ApiType);
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
        var color = SchemaFields.At(GameRelease.Fallout4, table, path);

        Assert.Equal("color", color.Type);
        Assert.Null(color.Fields);
        Assert.Equal(holdsAlpha, color.HoldsAlpha);
    }

    [Fact]
    public void NoLeafButAColorHoldsAlpha()
    {
        Assert.False(Column("kywd", "EditorID").Field.HoldsAlpha);
    }

    private const string HeldAlphaWarningPrefix = "SchemaReflector: a colour's alpha unavailable";

    [Fact]
    public void MutagensBinaryTranslationAnswersForEveryColorTheWalkReaches()
    {
        var entries = new List<LogEntry>();
        using var factory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(entries)));
        new SchemaReflector(factory.CreateLogger<SchemaReflector>()).GetSchemas(GameRelease.Fallout4);
        Assert.True(entries.Count > 0, "Expected the collector to receive the walk's own trace; a collector wired to nothing would find zero refusals too.");

        var unanswered = entries.Where(e => e.Message.StartsWith(HeldAlphaWarningPrefix, StringComparison.Ordinal)).Select(e => e.Message).Distinct().ToList();
        Assert.True(unanswered.Count == 0, string.Join("\n", unanswered));
    }
}
