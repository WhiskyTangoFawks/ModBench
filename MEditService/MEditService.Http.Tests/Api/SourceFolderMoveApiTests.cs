using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class SourceFolderMoveApiTests : HostedTests
{
    private readonly ScratchDirectory _source = new("api-source-folder-move-");

    protected override void DisposeFixtures() => _source.Dispose();

    private string Old => Path.Combine(_source, "Old");

    private Task<HttpResponseMessage> MoveChanges(string movedTo) =>
        Client.PostAsJsonAsync("/source-folders/move-changes", new { sourceFolder = Old, movedTo, files = new[] { new { from = "Old.manifest.json", to = "New.manifest.json" } } });

    [Fact]
    public async Task AMove_Is200_AnswersTheMoves_AndWritesNothing()
    {
        Directory.CreateDirectory(Old);
        File.WriteAllText(Path.Combine(Old, "Old.manifest.json"), "{}");
        var renamed = Path.Combine(_source, "New");

        var response = await MoveChanges(renamed);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var moves = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("moves").EnumerateArray().Select(move => move.GetProperty("to").GetString());
        Assert.Equal([renamed, Path.Combine(renamed, "New.manifest.json")], moves);
        Assert.True(Directory.Exists(Old));
    }

    [Fact]
    public async Task AMoveOntoAFolderAlreadyThere_Is409FolderTaken()
    {
        Directory.CreateDirectory(Old);
        var taken = Directory.CreateDirectory(Path.Combine(_source, "Taken")).FullName;

        var response = await MoveChanges(taken);

        Assert.Equal("FolderTaken", (await response.AssertIsProblem(HttpStatusCode.Conflict)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task FollowingAMoveOutsideAnyRepository_Is204()
    {
        var renamed = Directory.CreateDirectory(Path.Combine(_source, "New")).FullName;

        var response = await Client.PostAsJsonAsync("/source-folders/follow-move", new { sourceFolder = Old, movedTo = renamed });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }
}
