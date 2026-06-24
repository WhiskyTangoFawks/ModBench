using MEditService.Core.Edits;

namespace MEditService.Tests.Edits;

public sealed class VmadPathTests
{
    [Fact]
    public void TryParse_ValidPath_ReturnsScriptAndProperty()
    {
        var ok = VmadPath.TryParse(@"VMAD\MyScript\MyProp", out var script, out var prop);
        Assert.True(ok);
        Assert.Equal("MyScript", script);
        Assert.Equal("MyProp", prop);
    }

    [Fact]
    public void TryParse_NonVmadPrefix_ReturnsFalse()
    {
        var ok = VmadPath.TryParse("aggression", out _, out _);
        Assert.False(ok);
    }

    [Fact]
    public void TryParse_EmptyScriptName_ReturnsFalse()
    {
        // sep == 0 → script name is empty
        var ok = VmadPath.TryParse(@"VMAD\\Prop", out _, out _);
        Assert.False(ok);
    }

    [Fact]
    public void TryParse_EmptyPropertyName_ReturnsFalse()
    {
        // trailing backslash → property name is empty
        var ok = VmadPath.TryParse(@"VMAD\Script\", out _, out _);
        Assert.False(ok);
    }

    [Fact]
    public void TryParse_NoPropertySeparator_ReturnsFalse()
    {
        // only one segment after VMAD\ → sep == -1
        var ok = VmadPath.TryParse(@"VMAD\ScriptNameOnly", out _, out _);
        Assert.False(ok);
    }

    [Fact]
    public void TryParseScript_ScriptLevelPath_ReturnsScriptName()
    {
        var ok = VmadPath.TryParseScript(@"VMAD\MyScript", out var script);
        Assert.True(ok);
        Assert.Equal("MyScript", script);
    }

    [Fact]
    public void TryParseScript_NonVmadPrefix_ReturnsFalse()
    {
        Assert.False(VmadPath.TryParseScript("aggression", out _));
    }

    [Fact]
    public void TryParseScript_PropertyLevelPath_ReturnsFalse()
    {
        // has a property segment → not a script-level path
        Assert.False(VmadPath.TryParseScript(@"VMAD\MyScript\MyProp", out _));
    }

    [Fact]
    public void TryParseScript_EmptyScriptName_ReturnsFalse()
    {
        Assert.False(VmadPath.TryParseScript(@"VMAD\", out _));
    }
}
