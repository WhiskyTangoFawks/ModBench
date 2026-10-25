using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginLocalizedTests : TestInstance
{
    private readonly PluginAddress _plugin;

    public CompilePluginLocalizedTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4) { UsingLocalization = true };
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, "The Big Door");
        _plugin = Add(mod, "FixtureMod");
    }

    private string StringsFolder => Path.Combine(ModFolderOf(_plugin), "Strings");

    private Dictionary<string, byte[]> StringsFiles() =>
        Directory.GetFiles(StringsFolder).ToDictionary(file => Path.GetFileName(file), File.ReadAllBytes, StringComparer.Ordinal);

    [Fact]
    public async Task Compile_ALocalizedPlugin_WritesItLocalized_WithStringsBesideItByteIdenticalToTheInput()
    {
        var input = StringsFiles();
        Assert.Equal(["Fixture_en.DLSTRINGS", "Fixture_en.ILSTRINGS", "Fixture_en.STRINGS"], input.Keys.Order(StringComparer.Ordinal));
        Directory.Delete(StringsFolder, recursive: true);

        using var compiled = await this.CompiledAsync(_plugin);

        Assert.True(compiled.ModHeader.Flags.HasFlag(Fallout4ModHeader.HeaderFlag.Localized));
        Assert.Equal(input, StringsFiles());
    }
}
