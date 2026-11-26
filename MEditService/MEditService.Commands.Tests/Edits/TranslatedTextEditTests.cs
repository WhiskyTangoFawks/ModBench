using System.Text.Json.Nodes;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Strings;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class TranslatedTextEditTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new(Language.French);

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public async Task AnEditToText_InALocalizedPlugin_IsItsTextInTheStringsLanguage()
    {
        _fixture.Localize();
        var formKey = _fixture.Seed(new Weapon(KeyOf(0x800), Fallout4Release.Fallout4) { EditorID = "Gun", Name = "10mm" }, "weap");

        var outcome = (await _fixture.ScriptEditHandler.Edit(_fixture.Plugin, formKey, Spelled("set", "Name", "\"Pistolet\""), copiesWithNoPluginSource: Envelopes.NoCopies, CancellationToken.None)).AsResult();

        Assert.True(outcome.Applied, outcome.Message);
        var french = JsonNode.Parse(_fixture.Document(formKey)).Require()["Name"].Require()["Values"].Require().AsArray()
            .Single(entry => entry.Require()["Language"].Require().GetValue<string>() == "French");

        Assert.Equal("Pistolet", french.Require()["String"].Require().GetValue<string>());
    }
}
