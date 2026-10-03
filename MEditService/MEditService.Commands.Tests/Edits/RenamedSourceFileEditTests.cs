using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class RenamedSourceFileEditTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private EditRecordHandler EditService() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void AFileRenamedOnDiskWithItsContentUnchanged_IsStillFoundAndEditedInPlace_NotRecreatedAtTheStalePath()
    {
        var originalPath = _mod.NpcSourceFile;
        var renamed = Path.Combine(
            Path.GetDirectoryName(originalPath) ?? throw new InvalidOperationException($"Expected '{originalPath}' to have a parent directory."),
            $"SomeOtherName - {_mod.Npc.ID:X6}_{_mod.Npc.ModKey.FileName}.json");
        File.Move(originalPath, renamed);

        var result = EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.6"));

        Assert.True(result.Applied, result.Message);
        Assert.False(File.Exists(originalPath));
        Assert.Contains("0.6", File.ReadAllText(renamed), StringComparison.Ordinal);
        Assert.NotNull(_mod.Document(_mod.Npc.ToString()));
    }
}
