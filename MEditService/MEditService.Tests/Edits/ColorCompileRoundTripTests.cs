using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>Asserted against the record reparsed from the compiled binary, never the source
/// document: Color was always safe in the document; the editor surface is what reaches the
/// binary.</summary>
public sealed class ColorCompileRoundTripTests : IDisposable
{
    private readonly ColorCompileFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private ProjectingEditService EditService() =>
        ProjectingEditService.Over(_fixture.Mirror);

    private IFallout4ModGetter CompileAndReparse()
    {
        var result = CompileServices.Over(_fixture.Mirror)
            .Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_fixture.ModFolder, ColorCompileFixture.PluginName);
        return (IFallout4ModGetter)ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ColorCompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
    }

    private void Edit(FormKey record, string field, string json)
    {
        var result = EditService().Set(_fixture.Plugin, record.ToString(), field, Json(json));
        Assert.True(result.Applied, result.Message);
    }

    // ── AC #4: a second common Color carrier, on the 3-leaf (wbByteColors) shape ───────────────

    [Fact]
    public void Light_ColorEdit_CompilesAndReparsesTheNewRgb()
    {
        Edit(_fixture.Light, "Color", "\"#C86432\"");

        var light = CompileAndReparse().Lights.Single(l => l.FormKey == _fixture.Light);
        Assert.Equal(200, light.Color.R);
        Assert.Equal(100, light.Color.G);
        Assert.Equal(50, light.Color.B);
    }

    // The document spells a color with its alpha byte, and an edit in that spelling keeps it.
    [Fact]
    public void Light_ColorEdit_InTheDocumentsOwnSpelling_KeepsTheAlphaByteItNames()
    {
        Edit(_fixture.Light, "Color", "\"#89C86432\"");

        var light = CompileAndReparse().Lights.Single(l => l.FormKey == _fixture.Light);
        Assert.Equal(ColorCompileFixture.SeededLightAlpha, light.Color.A);
        Assert.Equal((200, 100, 50), (light.Color.R, light.Color.G, light.Color.B));
    }

    // ── Coordinator's addition: one compile proof per allowlist row ────────────────────────────

    [Theory]
    [InlineData("kywd")]
    [InlineData("lcrt")]
    [InlineData("aact")]
    [InlineData("lctn")]
    public void AllowlistedColorField_AlphaEdit_CompilesAndReparsesAllFourComponents(string table)
    {
        var record = table switch
        {
            "kywd" => _fixture.Keyword,
            "lcrt" => _fixture.LocationReferenceType,
            "aact" => _fixture.ActionRecord,
            "lctn" => _fixture.Location,
            _ => throw new ArgumentOutOfRangeException(nameof(table), table, "unknown allowlist table"),
        };

        Edit(record, "Color", "\"#A0285078\"");

        var mod = CompileAndReparse();
        var actual = table switch
        {
            "kywd" => mod.Keywords.Single(r => r.FormKey == record).Color,
            "lcrt" => mod.LocationReferenceTypes.Single(r => r.FormKey == record).Color,
            "aact" => mod.Actions.Single(r => r.FormKey == record).Color,
            "lctn" => mod.Locations.Single(r => r.FormKey == record).Color,
            _ => null,
        };

        Assert.NotNull(actual);
        Assert.Equal((40, 80, 120, 160), (actual.Value.R, actual.Value.G, actual.Value.B, actual.Value.A));
    }

    // ── The float-encoded storage, against a real compile ──────────────────────────────────────

    [Fact]
    public void FloatEncodedColor_Edit_CompilesAndReparsesTheExactBytes()
    {
        Edit(_fixture.MaterialObject, "SinglePassColor", "\"#01FE7F\"");

        var materialObject = CompileAndReparse().MaterialObjects.Single(m => m.FormKey == _fixture.MaterialObject);
        Assert.Equal(1, materialObject.SinglePassColor.R);
        Assert.Equal(254, materialObject.SinglePassColor.G);
        Assert.Equal(127, materialObject.SinglePassColor.B);
    }
}
