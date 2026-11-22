using MEditService.RepositoriesLib;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class WrittenFilesTests
{
    private static readonly string Root = Path.GetFullPath("written-files");

    private static string At(params string[] parts) => Path.Combine([Root, .. parts]);

    [Fact]
    public async Task AWrite_AnswersEachPathItsRepositoriesNamed_AcrossAnAwait()
    {
        var (answer, written) = await WrittenFiles.Of(async () =>
        {
            WrittenFiles.Name(At("a.esp"));
            await Task.Yield();
            WrittenFiles.Name(At("Strings", "a_en.strings"));
            return 1;
        });

        Assert.Equal(1, answer);
        Assert.Equal([At("Strings", "a_en.strings"), At("a.esp")], written.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void APathBelowAnotherNamed_StandsInIt_AndAPathNamedTwiceIsNamedOnce()
    {
        var (_, written) = WrittenFiles.Of(() =>
        {
            WrittenFiles.Name(At("source", "plugin-source", "a.esp", "Weapons", "Gun.json"));
            WrittenFiles.Name(At("source", "plugin-source", "a.esp"));
            WrittenFiles.Name(At("source", "plugin-source", "a.esp"));
            WrittenFiles.Name(At("source", "plugin-source", "a.esp.json"));
            return 0;
        });

        Assert.Equal([At("source", "plugin-source", "a.esp"), At("source", "plugin-source", "a.esp.json")], written.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void APathNamedOutsideAWrite_IsHeardByNone()
    {
        WrittenFiles.Name(At("outside.esp"));

        var (_, written) = WrittenFiles.Of(() => 0);

        Assert.Empty(written);
    }
}
