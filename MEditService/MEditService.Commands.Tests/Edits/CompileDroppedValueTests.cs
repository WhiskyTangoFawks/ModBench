using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompileDroppedValueTests : IDisposable
{
    private const string Quest = "000801:DocEdit.esp";

    private readonly DocumentEditFixture _fixture = new();

    public CompileDroppedValueTests() =>
        _fixture.Seed(new Quest(KeyOf(0x801), Fallout4Release.Fallout4) { EditorID = "Quest", Aliases = [new QuestLocationAlias { Name = "OriginalLoc" }] }, "qust");

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public async Task AnEditedValueThePluginWrittenFromTheSourceWouldNotHold_RefusesCompile_NamingTheFileAndTheValue_AndWritesNothing()
    {
        var edited = _fixture.EditHandler.Set(_fixture.Plugin, Quest, "Aliases", JsonDocument.Parse("""[{"MutagenObjectType": "QuestCollectionAlias"}]""").RootElement);
        Assert.True(edited.Applied, edited.Message);
        var pluginPath = Path.Combine(_fixture.ModFolderOf(_fixture.Plugin), _fixture.Plugin.Name);
        var before = await File.ReadAllBytesAsync(pluginPath);

        var answer = (await _fixture.CompileHandler.CompileAsync([_fixture.Plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.SourceValueDropped, refused.Refusal);
        var file = TreeTampering.FileOf(_fixture.ModFolderOf(_fixture.Plugin), _fixture.Plugin, new RecordIdentity(Quest, "qust", "Quest"));
        Assert.Contains($"would not hold, in {Path.GetRelativePath(_fixture.ModFolderOf(_fixture.Plugin), file)}, 'Aliases[0]'.", refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, await File.ReadAllBytesAsync(pluginPath));
    }
}
