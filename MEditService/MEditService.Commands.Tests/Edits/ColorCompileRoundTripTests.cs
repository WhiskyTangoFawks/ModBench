using System.Drawing;
using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;

namespace MEditService.Commands.Tests.Edits;

public sealed class ColorCompileRoundTripTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public async Task AColorEdit_CompilesToABinaryHoldingEveryComponentItNames()
    {
        var keyword = _fixture.Seed(new Keyword(KeyOf(0x801), Fallout4Release.Fallout4) { EditorID = "Keyword", Color = Color.FromArgb(1, 2, 3, 4) }, "kywd");
        var edited = _fixture.EditHandler.Set(_fixture.Plugin, keyword, "Color", JsonDocument.Parse("\"#A0285078\"").RootElement);
        Assert.True(edited.Applied, edited.Message);

        using var compiled = await _fixture.CompiledAsync(_fixture.Plugin);

        Assert.Equal<Color?>(Color.FromArgb(0xA0, 0x28, 0x50, 0x78), compiled.Keywords.Single().Color);
    }
}
