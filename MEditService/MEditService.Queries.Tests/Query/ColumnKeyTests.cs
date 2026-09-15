using MEditService.Index;
using MEditService.LoadOrder;

namespace MEditService.Tests.Query;

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
    public void Of_DataDirectoryOrigin_ProducesPlainFilename()
    {
        // A Data-directory-resolved plugin is already uniquely identified by its filename, there
        // being only one Data/, so the reserved origin is elided rather than appended.
        Assert.Equal("Shared.esp", ColumnKey.Of("Shared.esp", PluginOrigin.DataDirectory));
    }
}
