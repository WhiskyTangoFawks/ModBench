using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A file a user renamed by hand, content unchanged, is still the record's file: the write
/// path resolves it by the repository's fallback scan rather than a stale computed path.</summary>
public sealed class RenamedSourceFileEditTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private EditRecordHandler EditService() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void AFileRenamedOnDiskWithItsContentUnchanged_IsStillFoundAndEditable()
    {
        // NpcSourceFile resolves the record's real current file live off disk, so it must be captured
        // before the hand-rename below, or every later read would just re-find the file at its new spot.
        var originalPath = _mod.NpcSourceFile;
        var renamed = Path.Combine(
            PathShape.DirectoryOf(originalPath),
            $"SomeOtherName - {_mod.Npc.ID:X6}_{_mod.Npc.ModKey.FileName}.json");
        File.Move(originalPath, renamed);

        var result = EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.6"));

        Assert.True(result.Applied, result.Message);
        // Written into the file that actually holds the record, not recreated at the stale computed
        // path — two files claiming one FormKey is the corruption AmbiguousSourceUnitException exists
        // for.
        Assert.False(File.Exists(originalPath));
        Assert.Contains("0.6", File.ReadAllText(renamed), StringComparison.Ordinal);
        Assert.NotNull(_mod.Document(_mod.Npc.ToString()));
    }
}
