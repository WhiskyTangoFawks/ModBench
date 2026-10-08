using MEditService.Index;
using MEditService.LoadOrder;

namespace MEditService.Queries.Tests.Query;

public class ColumnKeyTests
{
    [Fact]
    public void Of_SameFilenameAndOrigin_ProducesEqualKeys()
    {
        Assert.Equal(ColumnKey.Of("Shared.esp", "ModA"), ColumnKey.Of("Shared.esp", "ModA"));
    }

    [Fact]
    public void Of_SameFilenameDifferentOrigin_ProducesDistinctKeys()
    {
        Assert.NotEqual(ColumnKey.Of("Shared.esp", "ModA"), ColumnKey.Of("Shared.esp", "ModB"));
    }

    [Fact]
    public void Of_DataDirectoryOrigin_ProducesPlainFilename_ForTheOnlyDataDirectoryAlreadyIdentifiesThePlugin()
    {
        Assert.Equal("Shared.esp", ColumnKey.Of("Shared.esp", PluginOrigin.DataDirectory));
    }

    [Theory]
    [InlineData("Data")]
    [InlineData("overwrite")]
    public void Of_ModFolderNamedLikeAReservedOrigin_KeepsItsOwnColumnApartFromTheReservedOne(string modFolder)
    {
        var reserved = modFolder == "Data" ? PluginOrigin.DataDirectory : PluginOrigin.Overwrite;

        Assert.NotEqual(ColumnKey.Of("Shared.esp", reserved), ColumnKey.Of("Shared.esp", modFolder));
    }
}
