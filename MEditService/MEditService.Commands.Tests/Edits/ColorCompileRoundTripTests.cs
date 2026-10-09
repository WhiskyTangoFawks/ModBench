using System.Drawing;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class ColorCompileRoundTripTests : IDisposable
{
    private readonly ColorCompileFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private TestEditor EditService() => _fixture.EditHandler;

    private async Task<IFallout4ModGetter> CompileAndReparse()
    {
        await CompileServices.Over(_fixture.LoadOrder).CompileLandedAsync(_fixture.Plugin);

        var pluginPath = Path.Combine(_fixture.ModFolder, ColorCompileFixture.PluginName);
        return (IFallout4ModGetter)ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ColorCompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
    }

    private void Edit(FormKey record, string field, string json)
    {
        var result = EditService().Set(_fixture.Plugin, record.ToString(), field, Json(json));
        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public async Task Light_ColorEdit_CompilesAndReparsesTheNewRgb()
    {
        Edit(_fixture.Light, "Color", "\"#C86432\"");

        var light = (await CompileAndReparse()).Lights.Single(l => l.FormKey == _fixture.Light);
        Assert.Equal(200, light.Color.R);
        Assert.Equal(100, light.Color.G);
        Assert.Equal(50, light.Color.B);
    }

    [Fact]
    public async Task Light_ColorEdit_InTheDocumentsOwnSpelling_KeepsTheAlphaByteItNames()
    {
        Edit(_fixture.Light, "Color", "\"#89C86432\"");

        var light = (await CompileAndReparse()).Lights.Single(l => l.FormKey == _fixture.Light);
        Assert.Equal(ColorCompileFixture.SeededLightAlpha, light.Color.A);
        Assert.Equal((200, 100, 50), (light.Color.R, light.Color.G, light.Color.B));
    }

    private async Task AssertAlphaEditCompilesAndReparsesAllFourComponents(
        FormKey record, Func<IFallout4ModGetter, FormKey, Color?> colorOf)
    {
        Edit(record, "Color", "\"#A0285078\"");

        var actual = colorOf(await CompileAndReparse(), record);

        Assert.NotNull(actual);
        Assert.Equal((40, 80, 120, 160), (actual.Value.R, actual.Value.G, actual.Value.B, actual.Value.A));
    }

    [Fact]
    public Task Keyword_ByteRgbaAlphaEdit_CompilesAndReparsesAllFourComponents() =>
        AssertAlphaEditCompilesAndReparsesAllFourComponents(
            _fixture.Keyword, (mod, key) => mod.Keywords.Single(r => r.FormKey == key).Color);

    [Fact]
    public Task LocationReferenceType_ByteRgbaAlphaEdit_CompilesAndReparsesAllFourComponents() =>
        AssertAlphaEditCompilesAndReparsesAllFourComponents(
            _fixture.LocationReferenceType, (mod, key) => mod.LocationReferenceTypes.Single(r => r.FormKey == key).Color);

    [Fact]
    public Task Action_ByteRgbaAlphaEdit_CompilesAndReparsesAllFourComponents() =>
        AssertAlphaEditCompilesAndReparsesAllFourComponents(
            _fixture.ActionRecord, (mod, key) => mod.Actions.Single(r => r.FormKey == key).Color);

    [Fact]
    public Task Location_ByteRgbaAlphaEdit_CompilesAndReparsesAllFourComponents() =>
        AssertAlphaEditCompilesAndReparsesAllFourComponents(
            _fixture.Location, (mod, key) => mod.Locations.Single(r => r.FormKey == key).Color);

    [Fact]
    public async Task FloatEncodedColor_Edit_CompilesAndReparsesTheExactBytes()
    {
        Edit(_fixture.MaterialObject, "SinglePassColor", "\"#01FE7F\"");

        var materialObject = (await CompileAndReparse()).MaterialObjects.Single(m => m.FormKey == _fixture.MaterialObject);
        Assert.Equal(1, materialObject.SinglePassColor.R);
        Assert.Equal(254, materialObject.SinglePassColor.G);
        Assert.Equal(127, materialObject.SinglePassColor.B);
    }

    [Fact]
    public async Task AColorHoldingNoAlpha_TypedAsRrggbb_ReadsAsTypedOnceCompiledToItsBinary()
    {
        Edit(_fixture.MaterialObject, "SinglePassColor", "\"#01FE7F\"");

        var compiled = (await CompileAndReparse()).MaterialObjects.Single(m => m.FormKey == _fixture.MaterialObject);
        using var document = JsonDocument.Parse(RecordTextCodec.SerializeToText(compiled, GameRelease.Fallout4));

        Assert.Equal("#0001FE7F", JsonStrings.Of(document.RootElement.GetProperty("SinglePassColor")));
    }
}
