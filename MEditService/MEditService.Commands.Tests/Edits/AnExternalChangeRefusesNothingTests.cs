namespace MEditService.Commands.Tests.Edits;

public sealed class AnExternalChangeRefusesNothingTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public async Task Compile_OverAnotherToolsBytes_ReplacesThem()
    {
        var path = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        byte[] theirs = "changed-by-xedit"u8.ToArray();
        File.WriteAllBytes(path, theirs);

        var result = await _mod.CompileService().CompileAsync([_mod.Plugin]);

        Assert.Empty(result.Refused);
        Assert.NotEqual(theirs, File.ReadAllBytes(path));
    }
}
