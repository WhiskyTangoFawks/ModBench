using MEditService.Commands.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class UnsavedDocumentHandlerTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.CompiledPlugin();

    public void Dispose() => _mod.Dispose();

    private string NpcFile => Path.Combine(_mod.ModFolder, _mod.DocumentFile(_mod.Npc.ToString()).Require());

    private Task<Answer<bool, UnsavedRefused>> Putting(string text, long version, bool opened) =>
        _mod.PutUnsavedDocumentHandler.Put(new DocumentChange(NpcFile, text), version, opened, CancellationToken.None);

    private static void Taken(Answer<bool, UnsavedRefused> answer) =>
        Assert.True(answer.Holds(out _, out var refused), refused?.Message);

    [Fact]
    public async Task ADocumentPut_IsHandedToTheRecordIndexAsTheFileOfItsPlugin()
    {
        Taken(await Putting("typed", 1, opened: true));

        var handed = Assert.Single(Assert.Single(_mod.Index.Hands).Require());
        Assert.Equal(_mod.Plugin, handed.Plugin);
        Assert.Equal([NpcFile], handed.Files);
    }

    [Fact]
    public async Task ADocumentPutAgainWithTheTextHeld_IsNotHandedAgain()
    {
        await Putting("typed", 1, opened: true);

        Taken(await Putting("typed", 2, opened: false));

        Assert.Single(_mod.Index.Hands);
    }

    [Fact]
    public async Task ADocumentDeleted_IsHandedOnce_AndADocumentNeverHeldIsNot()
    {
        await Putting("typed", 1, opened: true);

        Taken(await _mod.DeleteUnsavedDocumentHandler.Delete(NpcFile, CancellationToken.None));
        Taken(await _mod.DeleteUnsavedDocumentHandler.Delete(NpcFile, CancellationToken.None));

        Assert.Equal(2, _mod.Index.Hands.Count);
    }
}
