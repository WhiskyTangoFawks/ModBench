namespace MEditService.ModFolderAdapter.Tests;

/// <summary>A mod's manifest as a file in its folder, the text the repository spells for a source mod's.</summary>
internal static class ManifestOnDisk
{
    internal static void Write(ModFolderRepository repository, string modFolder, Manifest manifest)
    {
        var name = Path.GetFileName(modFolder);
        File.WriteAllBytes(Path.Combine(modFolder, $"{name}.manifest.json"), repository.SpellSourceManifest(manifest with { Output = name }).Text);
    }
}
