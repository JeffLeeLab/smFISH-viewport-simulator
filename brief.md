# smFIH viewport

an interactive ThreeJS webapp for visualisation of single-molecule FISH (smFISH) probes, mRNA and resulting cell. 

## Objective

- create a beautiful interactive (zoom, rotatable etc) web app that allows simple viualisation of mRNA molecules and smFISH probes (singly-labelled at 3' ends) properly hybridised.
- Then an zoom out view of a cell showing that this multiple probes lead to a single diffraction limited microscopy spot that is appriximatable to a point-spread function (PSF)
- Design idea similar to this "https://sael.net/plane-of-focus/"
- As interactive as possible. 


### RNA moleucule

- an mRNA floating in dark cellular background
- line backbone with spherical m7G cap, individual bases as sticks perhaps? 
- 3'UTR region, CDS and 5'UTR regions in different dark colours


### probes 

- two different sets, one set against the ends of 3'UTR (closer to polyA tail) and the other set against CDS
- each set is around ~10 probes for simplicity, fluorochromes (bright and shining) same colour for the same set, green and magenta
- fluorochromes attached to the 3'end of the probes
- probes typically 18 nt long, but for simplicity just show 3-4 sticks that hybridise to the mRNA (like a ladder)
- hybridisation similar to this [example](https://en-cdn.bio-protocol.org/attached/image/20181031/20181031200314_7311.jpg)
- beautifully rendered. 


### microscopy image

- zoom out view showing two channels (green, magenta and merged) - merged would be white (channels toggle-able)
- diffraction limited spot shown in 3D (interactive and rotatable, shows elongated shape in axial resolution of 3D gaussian)
- dark background, microscopy like


### image below (still brainstorming)

- Showing diffraction limited spots in slightly translucent cell. similar to this [example](https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTSiJj-dRMbGiD3B_erei9rKdNk1xCdGUG8Dx-666H2TA&s=10). 






