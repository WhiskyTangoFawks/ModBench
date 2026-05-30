using Mutagen.Bethesda;

namespace MEditService.Api;

public record CliArgs(string? DataFolderPath, string? PluginsTxtPath, GameRelease? GameRelease)
{
    public static CliArgs Parse(string[] args)
    {
        string? dataFolder = null;
        string? pluginsTxt = null;
        GameRelease? gameRelease = null;

        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--data-folder") dataFolder = args[i + 1];
            else if (args[i] == "--plugins-txt") pluginsTxt = args[i + 1];
            else if (args[i] == "--game" && Enum.TryParse<GameRelease>(args[i + 1], out var gr)) gameRelease = gr;
        }

        return new CliArgs(dataFolder, pluginsTxt, gameRelease);
    }
}
